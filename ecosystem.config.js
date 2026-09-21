module.exports = {
  apps: [
    {
      name: "EsprinServer",
      script: "EsprinServer.py",
      interpreter: "python3",
      args: "--host 0.0.0.0",
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env: {
        PYTHONUNBUFFERED: "1"
      }
    }
  ]
};