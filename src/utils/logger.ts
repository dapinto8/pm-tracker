const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

const fmt = (level: string, msg: string) =>
  `${new Date().toISOString()} [${level}] ${msg}`;

export const logger = {
  info: (msg: string) => console.log(fmt('INFO', msg)),
  warn: (msg: string) => console.warn(fmt('WARN', msg)),
  error: (msg: string) => console.error(fmt('ERROR', msg)),
  debug: (msg: string) => {
    if (LOG_LEVEL === 'debug') console.log(fmt('DEBUG', msg));
  },
};
