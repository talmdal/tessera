// The Settings Inspector's dialog: every namespace, what plugins read, its defaults and its file, and whether they
// agree. Read-only. It reads the report again after any settings change (and on Refresh).
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import {
  Alert, Box, Button, DialogActions, DialogContent, Icon, List, ListItemButton, ListItemIcon, ListItemText, Stack, Typography
} from '@tessera/ui'
import { INSPECTOR, type Check, type FileReport, type InspectorReport, type NamespaceReport } from '../shared'

/** The shell's push event after a setting changes. The file is written just after, so the report waits a moment. */
const SETTINGS_CHANGED = 'shell:settings.changed'
const AFTER_WRITE_MS = 300

const LOOK: Record<Check, { icon: string, colour: 'success' | 'warning' | 'error', severity: 'success' | 'warning' | 'error', label: string }> = {
  defaults: { icon: 'Check', colour: 'success', severity: 'success', label: 'At its defaults' },
  matches: { icon: 'Check', colour: 'success', severity: 'success', label: 'Matches its file' },
  differs: { icon: 'Warning', colour: 'warning', severity: 'warning', label: 'Differs from its file' },
  unreadable: { icon: 'Error', colour: 'error', severity: 'error', label: 'File unreadable' }
}

const time = (iso: string) => new Date(iso).toLocaleTimeString()
const json = (value: unknown) => JSON.stringify(value, null, 2)

export default function InspectorDialog({ close }: DialogProps) {
  const [report, setReport] = useState<InspectorReport>()
  const [error, setError] = useState<string>()
  const [selected, setSelected] = useState<string>()

  const load = useCallback(() => {
    window.api.invoke<InspectorReport>(INSPECTOR.report).then(
      next => { setReport(next); setError(undefined) },
      err => setError(String((err as Error)?.message ?? err)))
  }, [])

  // First load, then again a moment after each settings change (from Options in any window, or a plugin)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => {
    load()
    const stop = window.api.on(SETTINGS_CHANGED, () => {
      clearTimeout(timer.current)
      timer.current = setTimeout(load, AFTER_WRITE_MS)
    })
    return () => { stop(); clearTimeout(timer.current) }
  }, [load])

  const entries = report ? [...report.namespaces.map(n => n.id), ...report.others.map(f => f.name)] : []
  const current = selected !== undefined && entries.includes(selected) ? selected : entries[0]
  const namespace = report?.namespaces.find(n => n.id === current)
  const other = report?.others.find(f => f.name === current)

  return (
    <>
      <DialogContent dividers sx={{ p: 0 }}>
        {error && <Alert severity="error" sx={{ m: 2 }}>The settings could not be read: {error}</Alert>}
        {!report && !error && <Typography sx={{ p: 2 }} color="text.secondary">Reading the settings…</Typography>}
        {report && (
          <Box sx={{ display: 'grid', gridTemplateColumns: '240px minmax(0, 1fr)', height: 'min(600px, 70vh)' }}>
            <Box component="nav" aria-label="Settings namespaces" sx={{ borderRight: 1, borderColor: 'divider', overflow: 'auto' }}>
              <List dense disablePadding>
                {report.namespaces.map(n => (
                  <ListItemButton key={n.id} selected={n.id === current} aria-current={n.id === current ? 'true' : undefined} onClick={() => setSelected(n.id)}>
                    <ListItemIcon sx={{ minWidth: 28 }}><Icon name={LOOK[n.check].icon} fontSize="small" color={LOOK[n.check].colour} titleAccess={LOOK[n.check].label} /></ListItemIcon>
                    <ListItemText primary={n.id} secondary={n.changed.length === 0 ? 'defaults' : `${n.changed.length} changed`} />
                  </ListItemButton>
                ))}
                {report.others.length > 0 && (
                  <Typography variant="overline" color="text.secondary" sx={{ display: 'block', px: 2, pt: 1 }}>Other files</Typography>
                )}
                {report.others.map(f => (
                  <ListItemButton key={f.name} selected={f.name === current} aria-current={f.name === current ? 'true' : undefined} onClick={() => setSelected(f.name)}>
                    <ListItemIcon sx={{ minWidth: 28 }}><Icon name="Info" fontSize="small" titleAccess="Not read by any namespace" /></ListItemIcon>
                    <ListItemText primary={f.name} />
                  </ListItemButton>
                ))}
              </List>
            </Box>

            <Box sx={{ overflow: 'auto', p: 2, minWidth: 0 }}>
              <Folder report={report} />
              {namespace && <NamespaceDetail namespace={namespace} />}
              {other && <OtherFile file={other} />}
            </Box>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        {report && <Typography variant="caption" color="text.secondary" sx={{ mr: 'auto', pl: 1 }}>Read at {time(report.at)}</Typography>}
        <Button onClick={load}>Refresh</Button>
        <Button variant="contained" onClick={() => close()}>Close</Button>
      </DialogActions>
    </>
  )
}

function Folder({ report }: { report: InspectorReport }) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 2 }}>
      <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
        Settings folder: <Box component="span" sx={{ fontFamily: 'monospace' }}>{report.folder}</Box>
        {!report.folderExists && ' (not created yet: nothing has been saved)'}
      </Typography>
      <CopyButton text={report.folder} label="Copy the folder" />
    </Stack>
  )
}

function NamespaceDetail({ namespace: n }: { namespace: NamespaceReport }) {
  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h6" component="h2">{n.id}</Typography>
        <Typography variant="body2" color="text.secondary">
          Registered by {n.owner}. {n.changed.length === 0 ? 'Nothing differs from the defaults.' : `Differs from the defaults: ${n.changed.join(', ')}.`}
        </Typography>
      </Box>
      <Alert severity={LOOK[n.check].severity}>{LOOK[n.check].label}. {n.note}</Alert>
      {n.readOnly && <Alert severity="info">{n.readOnly}</Alert>}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 2 }}>
        <Code title="In effect (what plugins read)" text={json(n.value)} />
        {n.file
          ? <Code title={`Saved file (written ${time(n.file.modified)})`} text={n.file.text} path={n.file.path} />
          : <Code title="Saved file" text="(no file: only settings that differ from their defaults are saved)" />}
        <Code title="Defaults" text={json(n.defaults)} />
      </Box>
    </Stack>
  )
}

function OtherFile({ file }: { file: FileReport }) {
  const aside = file.name.endsWith('.bad')
  return (
    <Stack spacing={2}>
      <Typography variant="h6" component="h2">{file.name}</Typography>
      <Alert severity="info">
        {aside
          ? 'Set aside because it could not be read when Tessera started. It is kept so it can be repaired by hand; Tessera never reads it.'
          : 'No registered namespace reads this file: its plugin is not installed or not active. It is kept, and used again if the plugin returns.'}
      </Alert>
      <Code title={`File (written ${time(file.modified)})`} text={file.text} path={file.path} />
    </Stack>
  )
}

function Code({ title, text, path }: { title: string, text: string, path?: string }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
        <Typography variant="subtitle2" component="h3" sx={{ flexGrow: 1 }}>{title}</Typography>
        {path && <CopyButton text={path} label="Copy the path" />}
      </Stack>
      <Box component="pre" aria-label={title}
        sx={{ m: 0, p: 1, borderRadius: 1, bgcolor: 'action.hover', fontFamily: 'monospace', fontSize: 12, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {text}
      </Box>
    </Box>
  )
}

function CopyButton({ text, label }: { text: string, label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button size="small" aria-label={label}
      onClick={() => navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }, () => {})}>
      {copied ? 'Copied' : 'Copy'}
    </Button>
  )
}
