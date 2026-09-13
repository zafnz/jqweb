/* The script inlined in the head, which settles the palette before the body is
   parsed. The head and body scripts are separate elements, so page.js reaches
   the theme through window.jqtheme rather than an import. */

import { startTheme } from '../theme.js';

window.jqtheme = startTheme();
