// Entry point for the interactive UI. bin/jarvis.mjs imports the bundled
// version of this file.
import React from 'react';
import { render } from 'ink';
import App from './App.jsx';

export function start({ config, resume }) {
  const instance = render(<App config={config} resume={resume} />, { exitOnCtrlC: false });
  return instance.waitUntilExit();
}
