module.exports = {
  apps: [
    {
      name: "alvin-bot",
      script: "dist/index.js",
      cwd: __dirname,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 8000, // Give Grammy enough time to commit Telegram update offset on shutdown
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
