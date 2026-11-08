// What the shell needs from @tessera/ui but plugins don't: the providers that connect it to the shell.
// Not part of the plugin-facing surface (index.ts), and not shared through federation: the shell reaches
// it by path, and it is the same module instance as the one behind `@tessera/ui` inside the shell.

export { IconRegistryProvider } from './iconRegistry'
export { ThemeStateContext } from './themeState'
export { FontRolesContext } from './fontRoles'
