import rootConfig from '../../vite.config.ts';
import { fileURLToPath } from 'node:url';
export default {
  ...rootConfig,
  test: {
    ...rootConfig.test,
    include: ['packages/dsh-ui/client-bootstrap.test.tsx'],
    sequence: { ...rootConfig.test.sequence, setupFiles: 'list' },
    setupFiles: [fileURLToPath(new URL('./profiler-test-setup.mjs', import.meta.url)), ...rootConfig.test.setupFiles],
  },
};
