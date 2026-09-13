/* The script inlined in the head, which settles the palette before the body is
   parsed. The head and body scripts are separate elements, so the theme button
   in page/bootstrap.ts reaches it through window.jqtheme, not an import. */

import { startTheme } from '../page/theme.ts';

window.jqtheme = startTheme();
