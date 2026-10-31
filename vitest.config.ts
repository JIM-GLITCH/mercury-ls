import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 只跑 server 端的纯单测；client/src/test 是依赖 VS Code 的 e2e，由 scripts/e2e.sh 运行
    include: ['server/src/test/**/*.test.ts'],
    environment: 'node',
  },
})
