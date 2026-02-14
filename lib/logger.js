const config = require("./config");

const logger = {
  info: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
  // Only logs in development — sensitive data stays out of production logs
  debug: (...args) => {
    if (config.isDevelopment) {
      console.log(...args);
    }
  },
};

module.exports = logger;
