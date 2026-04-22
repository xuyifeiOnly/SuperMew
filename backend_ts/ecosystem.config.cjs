module.exports = {
  apps: [
    {
      name: 'supermew-backend-ts',
      cwd: __dirname,
      script: 'dist/server.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      time: true,
      env: {
        NODE_ENV: 'production',
        HOST: '0.0.0.0',
        PORT: 9008,
      },
    },
  ],
};

