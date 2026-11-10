import type { Register } from 'claude-code'

import { formatRow, loadFormat, pressFormat, pressSetting, registerFormat, settingRows } from './format-view'

const PANE = 'orch-ui'

export const register: Register = on => {
  registerFormat(on)

  // The one session.start hook of this plugin: a second unmatched one on that event is refused.
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'orch-ui', description: "Open orch-ui's settings" })
    void loadFormat($)

    return next(e)
  })

  on('command.run', { command: 'orch-ui' }, async $ => {
    await $.ui.open({ id: PANE, title: PANE, closeOnEscape: true })

    return { text: 'orch-ui settings opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const fmt = await formatRow($)
    const settings = await settingRows($)

    const check = (key: string, on_: boolean, label: string, note: string | null, press: () => void) => (
      <Box flexDirection="column" marginBottom={1}>
        <Button key={key} plain onPress={press}>
          <Text color={on_ ? 'success' : undefined}>{on_ ? '[x] ' : '[ ] '}</Text>{label}
        </Button>
        {note ? <Box paddingLeft={4}><Text dimColor>{note}</Text></Box> : null}
      </Box>
    )

    // A row that cycles through values: the same Button and layout as check(), drawing `<label>: <value>`.
    const choice = (key: string, label: string, value: string, note: string | null, press: () => void) => (
      <Box flexDirection="column" marginBottom={1}>
        <Box paddingLeft={4}>
          <Button key={key} plain onPress={press}>
            {label}: {value}
          </Button>
        </Box>
        {note ? <Box paddingLeft={4}><Text dimColor>{note}</Text></Box> : null}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {check('opt-format', fmt.on, 'Format replies', fmt.note, () => pressFormat($))}
        {settings.map(row => choice(row.key, row.label, row.value, row.note, () => pressSetting($, row.id)))}
      </Box>
    )
  })
}
