import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const stateDirectory = (env = process.env) =>
  env.PR_CHAT_STATE_DIR || join(homedir(), '.local/state/pr-chat');

export function reviewDatabase(directory) {
  return {
    client: 'better-sqlite3',
    connection: { filename: join(directory, 'inbox.sqlite') },
    useNullAsDefault: true,
    pool: {
      min: 1,
      max: 1,
      afterCreate(connection, done) {
        try {
          connection.pragma('journal_mode = WAL');
          connection.pragma('synchronous = FULL');
          connection.pragma('foreign_keys = ON');
        } catch (error) {
          return done(error, connection);
        }
        done(null, connection);
      },
    },
    migrations: { directory: fileURLToPath(new URL('./migrations/', import.meta.url)) },
  };
}
