/* The script inlined in the head, which settles the palette before the body is
   parsed and, on a served page, opens /alive. The head and body scripts are
   separate elements, so the theme button in page/bootstrap.ts reaches the
   theme through window.jqtheme, not an import. */

import { holdServer } from '../page/alive.ts';
import { startTheme } from '../page/theme.ts';

window.jqtheme = startTheme();
holdServer();
