
// Windows temporarily needs this file, https://github.com/module-federation/vite/issues/68

    import {loadShare} from "@module-federation/runtime";
    const importMap = {
      
        "react": async () => {
          throw new Error(`[Module Federation] Shared module '${"react"}' must be provided by host`);
        }
      ,
        "react-dom": async () => {
          throw new Error(`[Module Federation] Shared module '${"react-dom"}' must be provided by host`);
        }
      ,
        "react/jsx-runtime": async () => {
          throw new Error(`[Module Federation] Shared module '${"react/jsx-runtime"}' must be provided by host`);
        }
      
    }
      const usedShared = {
      
          "react": {
            name: "react",
            version: "18.2.0",
            scope: ["default"],
            loaded: false,
            from: "sample_builtin",
            async get () {
              if (true) {
                throw new Error(`[Module Federation] Shared module '${"react"}' must be provided by host`);
              }
              usedShared["react"].loaded = true
              const {"react": pkgDynamicImport} = importMap
              const res = await pkgDynamicImport()
              const exportModule = false && "react" === "react"
                ? (res?.default ?? res)
                : {...res}
              // All npm packages pre-built by vite will be converted to esm
              Object.defineProperty(exportModule, "__esModule", {
                value: true,
                enumerable: false
              })
              return function () {
                return exportModule
              }
            },
            shareConfig: {
              singleton: true,
              requiredVersion: "^18.2.0",
              import: false,
            }
          }
        ,
          "react-dom": {
            name: "react-dom",
            version: "18.2.0",
            scope: ["default"],
            loaded: false,
            from: "sample_builtin",
            async get () {
              if (true) {
                throw new Error(`[Module Federation] Shared module '${"react-dom"}' must be provided by host`);
              }
              usedShared["react-dom"].loaded = true
              const {"react-dom": pkgDynamicImport} = importMap
              const res = await pkgDynamicImport()
              const exportModule = false && "react-dom" === "react"
                ? (res?.default ?? res)
                : {...res}
              // All npm packages pre-built by vite will be converted to esm
              Object.defineProperty(exportModule, "__esModule", {
                value: true,
                enumerable: false
              })
              return function () {
                return exportModule
              }
            },
            shareConfig: {
              singleton: true,
              requiredVersion: "^18.2.0",
              import: false,
            }
          }
        ,
          "react/jsx-runtime": {
            name: "react/jsx-runtime",
            version: "18.2.0",
            scope: ["default"],
            loaded: false,
            from: "sample_builtin",
            async get () {
              if (true) {
                throw new Error(`[Module Federation] Shared module '${"react/jsx-runtime"}' must be provided by host`);
              }
              usedShared["react/jsx-runtime"].loaded = true
              const {"react/jsx-runtime": pkgDynamicImport} = importMap
              const res = await pkgDynamicImport()
              const exportModule = false && "react/jsx-runtime" === "react"
                ? (res?.default ?? res)
                : {...res}
              // All npm packages pre-built by vite will be converted to esm
              Object.defineProperty(exportModule, "__esModule", {
                value: true,
                enumerable: false
              })
              return function () {
                return exportModule
              }
            },
            shareConfig: {
              singleton: true,
              requiredVersion: "^18.2.0",
              import: false,
            }
          }
        
    }
      const usedRemotes = [
      ]
      export {
        usedShared,
        usedRemotes
      }
      