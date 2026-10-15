import path from 'node:path';
import os from 'node:os';

export function assistantDataPath(environment = process.env, platform = process.platform, home = os.homedir()) {
  const override = environment.PROJECT_MIND_DSH_USER_DATA;
  if (override) {
    if (!path.isAbsolute(override)) throw new Error('PROJECT_MIND_DSH_USER_DATA must be absolute');
    return override;
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'project-mind-dsh');
  if (platform === 'win32') return path.join(environment.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'project-mind-dsh');
  return path.join(environment.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'project-mind-dsh');
}

export function assistantEnvironment(environment = process.env) {
  const data = assistantDataPath(environment);
  const result = { ...environment, PROJECT_MIND_DSH_USER_DATA: data, DSH_HOME: data, DSH_TELEMETRY_DISABLED: '1' };
  delete result.ELECTRON_RUN_AS_NODE;
  return result;
}
