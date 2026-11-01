import test from 'node:test';
import assert from 'node:assert/strict';
import { browserEnvironment } from '../lib/browser-launcher.mjs';

test('owned Chromium receives only OS/browser environment and never parent credentials or preload/proxy settings', () => {
  const selected = browserEnvironment({ SystemRoot: 'C:\\Windows', PATH: 'owned-system-path', HOME: '/home/fixture', TMPDIR: '/tmp/fixture',
    XDG_RUNTIME_DIR: '/run/user/fixture', DISPLAY: ':1', LANG: 'en_US.UTF-8', OPENAI_API_KEY: 'not-a-real-key',
    CHAINCHAT_GATEWAY_TOKEN: 'not-a-real-control-token', CHAINCHAT_CHANNEL_ACCOUNT_PASSWORD: 'not-a-real-password',
    NODE_OPTIONS: '--import=untrusted.mjs', LD_PRELOAD: '/untrusted.so', DYLD_INSERT_LIBRARIES: '/untrusted.dylib',
    HTTP_PROXY: 'http://untrusted.invalid', HTTPS_PROXY: 'http://untrusted.invalid', ALL_PROXY: 'http://untrusted.invalid',
    NO_PROXY: '*', ELECTRON_RUN_AS_NODE: '1', SOME_UNKNOWN_SECRET: 'not-a-real-secret' });
  assert.deepEqual(selected, { SystemRoot: 'C:\\Windows', PATH: 'owned-system-path', HOME: '/home/fixture', TMPDIR: '/tmp/fixture',
    XDG_RUNTIME_DIR: '/run/user/fixture', DISPLAY: ':1', LANG: 'en_US.UTF-8' });
});
