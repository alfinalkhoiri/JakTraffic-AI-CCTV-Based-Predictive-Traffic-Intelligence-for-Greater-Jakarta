const path = require("path");

module.exports = {
  apps: [
    {
      name: "jaktraffic-backend",
      cwd: path.join(__dirname, "backend"),
      script: path.join(__dirname, "backend", ".venv", "bin", "python"),
      args: "app.py",
      env: {
        PYTHONUNBUFFERED: "1"
      }
    },
    {
      name: "jaktraffic-frontend",
      cwd: path.join(__dirname, "frontend"),
      script: "npm",
      args: "start",
      interpreter: "none",
      env: {
        HOST: "0.0.0.0",
        PORT: "3000",
        BROWSER: "none"
      }
    }
  ]
};
