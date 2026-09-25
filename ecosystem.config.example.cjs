// Example PM2 config. Copy to ecosystem.config.cjs, fill in your values, then:
//   pm2 start ecosystem.config.cjs
// See README.md "Deploy to a VPS" for the full production setup.
module.exports = {
  apps: [
    {
      name: 'chirp',
      script: 'src/server.mjs',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        PORT: '8899',
        COOKIES_FILE: './cookies.json',
        PUBLIC_HOST: 'chirp.example.com', // your tunnel hostname, or remove if local-only
        MCP_AUTH_KEY: 'change-me',        // generate with: openssl rand -hex 24
        X_USERNAME: 'your_handle',
      },
    },
  ],
};
