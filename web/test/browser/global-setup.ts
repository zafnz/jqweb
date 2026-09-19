/* Builds jqweb and renders the pages before any spec runs. */

import { renderAll } from './pages.ts';

export default function globalSetup() {
  renderAll();
}
