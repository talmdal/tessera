import { Button, Icon, Stack, Typography, useTheme, useThemeState } from '@tessera/ui'

/** A view written the way a plugin should: components, icons and theme access only through @tessera/ui. */
export default function ThemedView() {
  const theme = useTheme()
  const { mode } = useThemeState()

  return (
    <Stack>
      <Typography>Themed view</Typography>
      <Button startIcon={<Icon name="Save" />}>Press</Button>
      <Icon name="themed.logo" fallback="logo" />
      <span data-testid="primary">{theme.palette.primary.main}</span>
      <span data-testid="mode">{mode}</span>
    </Stack>
  )
}
