const { attach } = require('./saas-auth-runtime.cjs');

function patchExpressForSaaSAuth() {
  const modulePath = require.resolve('express');
  const express = require(modulePath);
  if (express.__taskosphereSaasAuthPatched) return;

  function wrappedExpress(...args) {
    const app = express(...args);
    if (!app.__taskosphereSaasAuthInstalled) {
      app.__taskosphereSaasAuthInstalled = true;
      const originalUse = app.use.bind(app);
      let useCount = 0;
      app.use = function patchedUse(...useArgs) {
        const result = originalUse(...useArgs);
        useCount += 1;
        if (useCount === 3) attach(app);
        return result;
      };
    }
    return app;
  }

  Object.assign(wrappedExpress, express);
  wrappedExpress.__taskosphereSaasAuthPatched = true;
  require.cache[modulePath].exports = wrappedExpress;
}

patchExpressForSaaSAuth();
