import esbuild from "esbuild"

/** @type {import('esbuild').BuildOptions} */
const baseConfig = {
  bundle: true,
  platform: 'node',
  target: 'node16',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
};

(async () => {
  try {
    await Promise.all([
      // Client (VS Code extension)
      esbuild.build({
        ...baseConfig,
        entryPoints: ['client/src/extension.ts'],
        outfile: 'client/out/extension.js',
        format: 'cjs',
      }),

      // Server (Language Server)
      esbuild.build({
        ...baseConfig,
        entryPoints: ['server/src/server.ts'],
        outfile: 'server/out/server.js',
        format: 'cjs',
      }),
    ]);

    console.log('✅ Build complete');
  } catch (err) {
    console.error('❌ Build failed');
    process.exit(1);
  }
})();