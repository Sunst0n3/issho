// Household admin from the command line:
//   cd server && npm run admin -- list        (or: node src/admin.ts list)
//   docker compose exec issho node server/src/admin.ts list
// It opens the server's own database and is safe while the server runs: SQLite's WAL mode lets
// both read at once, and each waits its turn to write. Changes show on the phones at their next
// refresh; revoked devices are cut off at their next request.

import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Member } from '../../shared/api.ts';
import { dataPaths, loadAdminConfig } from './config.ts';
import { Store } from './db.ts';
import { MemberNameSchema } from './routes/register.ts';

const HouseholdNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[^\p{C}]+$/u);

/** A failure explained to the user; anything else is unexpected. */
class AdminError extends Error {
  override name = 'AdminError';
}

interface Admin {
  store: Store;
  voiceDir: string;
  /** HOUSEHOLD_NAME, used until a name is set here. */
  defaultHouseholdName: string;
}

interface Command {
  usage: string;
  summary: string;
  /** Allowed argument counts. */
  args: readonly number[];
  run(admin: Admin, args: string[]): string | Promise<string>;
}

const COMMANDS: Record<string, Command> = {
  list: {
    usage: 'list',
    summary: 'Members, how many devices each has paired, and when they were last seen',
    args: [0],
    run({ store, defaultHouseholdName }) {
      const household = store.householdName() ?? defaultHouseholdName;
      const members = store.listMembers();
      if (members.length === 0) return `${household}: no members yet. Phones join with the household code.`;
      const rows = members.map((member) => [
        member.id,
        String(store.deviceCount(member.id)),
        formatTime(member.lastSeenAt),
        member.name,
      ]);
      return `${household}: ${plural(members.length, 'member')}\n\n${table(['ID', 'DEVICES', 'LAST SEEN', 'NAME'], rows)}`;
    },
  },

  rename: {
    usage: 'rename <member> <new name>',
    summary: "Change a member's name",
    args: [2],
    run({ store }, [ref, newName]) {
      const member = findMember(store, ref);
      const name = MemberNameSchema.safeParse(newName);
      if (!name.success) throw new AdminError('A name must be 1 to 40 characters, with no control characters.');
      const holder = store.findMemberByName(name.data);
      if (holder && holder.id !== member.id) throw new AdminError(`"${holder.name}" already has that name.`);
      store.renameMember(member.id, name.data);
      return `Renamed "${member.name}" to "${name.data}"`;
    },
  },

  revoke: {
    usage: 'revoke <member>',
    summary: "Sign out all of a member's devices (their phones must pair again)",
    args: [1],
    run({ store }, [ref]) {
      const member = findMember(store, ref);
      const count = store.revokeDevices(member.id);
      if (count === 0) return `"${member.name}" has no paired devices.`;
      return `Signed out "${member.name}" on ${plural(count, 'device')}. Their phones can pair again with the household code.`;
    },
  },

  remove: {
    usage: 'remove <member>',
    summary: 'Delete a member, their devices and stats (their chat messages stay)',
    args: [1],
    async run({ store, voiceDir }, [ref]) {
      const member = findMember(store, ref);
      const removed = store.removeMember(member.id);
      for (const file of removed.voiceFiles) {
        await unlink(path.join(voiceDir, file)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
      const kept =
        removed.messagesKept > 0
          ? `\nTheir ${plural(removed.messagesKept, 'chat message')} stay, shown as from a former member.`
          : '';
      return `Removed "${member.name}": signed out ${plural(removed.devices, 'device')}, deleted their stats and quizzes.${kept}`;
    },
  },

  'household-name': {
    usage: 'household-name [<name>]',
    summary: "Show or change the household's name",
    args: [0, 1],
    run({ store, defaultHouseholdName }, [newName]) {
      if (newName === undefined) return store.householdName() ?? defaultHouseholdName;
      const name = HouseholdNameSchema.safeParse(newName);
      if (!name.success) {
        throw new AdminError('A household name must be 1 to 60 characters, with no control characters.');
      }
      store.setHouseholdName(name.data);
      return `Household name set to "${name.data}"`;
    },
  },
};

const usageWidth = Math.max(...Object.values(COMMANDS).map((command) => command.usage.length));

export const USAGE = `Usage: node src/admin.ts <command>
  (with Docker: docker compose exec issho node server/src/admin.ts <command>)

Commands:
${Object.values(COMMANDS)
  .map((command) => `  ${command.usage.padEnd(usageWidth)}  ${command.summary}`)
  .join('\n')}

<member> is a member's id or name. Quote names with spaces: rename Aiko "Aiko T."
Works on the database in DATA_DIR, also while the server is running.`;

export interface AdminOptions {
  /** Reads DATA_DIR and HOUSEHOLD_NAME from here (default: process.env). */
  env?: NodeJS.ProcessEnv;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

/** Runs one command and returns the process exit code: 0 done, 1 failed, 2 usage error. */
export async function runAdmin(args: readonly string[], options: AdminOptions = {}): Promise<number> {
  const out = options.out ?? ((text: string) => console.log(text));
  const err = options.err ?? ((text: string) => console.error(text));

  const [name, ...rest] = args;
  if (name === 'help' || name === '--help' || name === '-h') {
    out(USAGE);
    return 0;
  }
  const command = name === undefined ? undefined : Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!command) {
    err(name === undefined ? USAGE : `Unknown command "${name}".\n\n${USAGE}`);
    return 2;
  }
  if (!command.args.includes(rest.length)) {
    err(`Usage: ${command.usage}\n(quote names that contain spaces)`);
    return 2;
  }

  const { dataDir, householdName } = loadAdminConfig(options.env ?? process.env);
  const paths = dataPaths(dataDir);
  // Opening a missing file would create an empty household, hiding a wrong DATA_DIR.
  if (!existsSync(paths.database)) {
    err(`No database at ${paths.database}. Set DATA_DIR to the server's data folder (the server creates it on first start).`);
    return 1;
  }

  let store: Store | undefined;
  try {
    store = new Store(paths.database);
    out(await command.run({ store, voiceDir: paths.voice, defaultHouseholdName: householdName }, rest));
    return 0;
  } catch (error) {
    if (error instanceof AdminError) err(error.message);
    else err(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    store?.close();
  }
}

function findMember(store: Store, ref: string): Member {
  const member = store.getMember(ref) ?? store.findMemberByName(ref);
  if (!member) throw new AdminError(`No member "${ref}". Run "list" to see the household.`);
  return member;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Local time (the TZ setting), to the minute. */
function formatTime(iso: string | null): string {
  if (iso === null) return 'never';
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Left-aligned columns. The last column isn't padded, so wide (Japanese) names can go there. */
function table(header: readonly string[], rows: readonly string[][]): string {
  const all = [header, ...rows];
  const widths = header.map((_, column) => Math.max(...all.map((row) => row[column].length)));
  return all
    .map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]))).join('  '))
    .join('\n');
}

if (import.meta.main) {
  // Same settings as `npm start`, which reads server/.env. Variables already set win.
  try {
    process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  process.exitCode = await runAdmin(process.argv.slice(2));
}
