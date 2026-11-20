const fs = require('node:fs')

function show(file, needle, before, after) {
  const t = fs.readFileSync(file, 'utf8')
  const i = t.indexOf(needle)
  console.log('##### ' + file.split('@deepseek-ai/')[1] + ' (index ' + i + ')')
  if (i < 0) return
  console.log(t.slice(Math.max(0, i - before), i + after))
  console.log('\n')
}

show('D:/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/src/client/apply.ts', "conversation.composer.dock", 700, 700)
show('D:/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/dsh-doc/templates/decoration/client.js', "composer.dock", 900, 900)
