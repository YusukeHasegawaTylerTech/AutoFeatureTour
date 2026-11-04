// The app a command works on when there's no tour to run: --platform <name> (with --target and --role), --tour
// <tour.json> (a platform tour or a stand-alone one), or a bare --base-url. Shared by the CLI and the session daemon.

import path from 'node:path';
import { composeTour, ConfigError, readTourJson } from './declarative.mjs';

/** { cfg, env, platform, authFile(role), name }, or null when the arguments name no app. */
export function appSettingsFor(toolRoot, args, { allowBareUrl = false } = {}) {
  const env = args.target ?? args.env;
  if (!args.platform && !args.tour) {
    if (!allowBareUrl || !(args.baseUrl || process.env.BASE_URL)) return null;
    const file = path.join(toolRoot, '_adhoc.tour.json');
    const c = composeTour({ name: 'adhoc', scenes: [] }, { file, toolRoot, baseUrl: args.baseUrl ?? process.env.BASE_URL });
    return { ...c, name: 'adhoc' };
  }
  const file = args.tour ? path.resolve(args.tour) : path.join(toolRoot, '_platform.tour.json');
  const raw = args.tour ? readTourJson(file) : { name: args.platform, platform: args.platform, scenes: [] };
  if (args.platform && args.tour && raw.platform && raw.platform !== args.platform) throw new ConfigError(`${args.tour} is a tour of ${raw.platform}, not ${args.platform}`);
  if (args.platform) raw.platform = args.platform;
  const c = composeTour(raw, { file, toolRoot, env, baseUrl: args.baseUrl, role: args.role });
  return { ...c, name: raw.platform ?? raw.name };
}
