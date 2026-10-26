// The `shell.views` extension point: what a plugin contributes, and what the
// renderer receives. The slot ids, channel names and the resolver live in
// shared/views/.

/**
 * A view, contributed from a plugin's privileged `activate` under the
 * `shell.views` extension point. Pure data: the component lives in the
 * plugin's renderer remote and is only loaded when the view is first shown.
 */
export interface ViewContribution {
  id: string
  /** Tab label, rail tooltip, loading and error messages; the section's accessible name. */
  title: string
  /** Where to render: 'shell.main', or a bar slot ('shell.top', 'shell.bottom', 'shell.left', 'shell.right'). */
  slot: string
  /** Module the plugin's renderer remote exposes, e.g. "./AccountsView". Its default export is the component. */
  module: string
  /**
   * "./path/in/renderer-folder.svg", or a name from the shell's icon set.
   * Required for bar slots (the collapsed rail shows it); optional for the main slot.
   */
  icon?: string
  /** Lower sorts first within the slot. Ties keep registration order. Defaults to 0. */
  order?: number
  /** Context-key expression; the view is absent while it evaluates to false. */
  when?: string
}

/** A view resolved by the main process, with everything the renderer needs to load it. */
export interface ViewDescriptor {
  id: string
  title: string
  slot: string
  module: string
  pluginId: string
  /** URL of the plugin's federation remote entry. */
  remoteEntry: string
  /** Resolved icon: a tessera-plugin:// URL for "./…" icons, or a shell icon-set name. */
  icon?: string
  /** The contribution's visibility expression. Presence is decided by the main process. */
  when?: string
}
