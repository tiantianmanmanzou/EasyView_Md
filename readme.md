# MdPre-zalman — WYSIWYG Markdown Editor for VS Code

A beautiful, feature-rich WYSIWYG Markdown editor inspired by [Outline](https://www.getoutline.com/). Rich editing powered by ProseMirror, integrated with VS Code themes.

---

## Editor

- **WYSIWYG editing** — visual editing with full Markdown serialization
- **Source mode** — switch to raw Markdown editing with CodeMirror 6 (`Ctrl+/`)
- **Auto-save** — seamless integration with VS Code document lifecycle
- **Dark / Light theme** — auto-detects VS Code theme and adapts
- **Zoom** — adjustable from 50% to 200%
- **Full width mode** — expand editor to use the entire panel width
- **Slash menu** (`/`) — quick-insert 30+ block types by typing `/` in an empty line
- **Floating toolbar** — context-aware formatting toolbar on text selection
- **Drag & drop blocks** — reorder any block by dragging the grip handle
- **Find & Replace** (`Ctrl+F`) — with match case, whole word, and regex support
- **Block movement** — move blocks up/down with `Ctrl+Alt+↑/↓`
- **Undo / Redo** — full history support
- **Placeholder hints** — helpful text in empty blocks

---

## Markdown Elements

### Text Formatting

| Format | Syntax | Shortcut |
|--------|--------|----------|
| **Bold** | `**text**` | `Ctrl+B` |
| *Italic* | `*text*` | `Ctrl+I` |
| Underline | `<u>text</u>` | `Ctrl+U` |
| ~~Strikethrough~~ | `~~text~~` | `Ctrl+D` |
| `Inline code` | `` `code` `` | `Ctrl+E` |
| Highlight | `==text==` | `Ctrl+Shift+H` |
| [Link](https://github.com/inlinemd/inlinemd/blob/HEAD/url) | `[text](https://github.com/inlinemd/inlinemd/blob/HEAD/url)` | `Ctrl+K` |

### Headings

Six heading levels (`# H1` through `###### H6`) with:
- Collapsible sections — click the arrow to collapse/expand
- Collapse all — toggle from the file header bar
- Anchor links — copy heading link for navigation
- Shortcuts: `Ctrl+Shift+1` through `Ctrl+Shift+4`

### Lists

- **Bullet list** (`Ctrl+Shift+8`)
- **Ordered list** (`Ctrl+Shift+9`)
- **Checkbox / task list** (`Ctrl+Shift+7`) — with checked, unchecked, and inapplicable states
- **Description list** — key-value definitions (GitLab syntax)
- Tab / Shift+Tab to indent / dedent

### Blockquotes

Nested blockquotes with styled left border. Toggle with `Ctrl+Shift+B`.

### Callout / Notice Blocks

Five callout types with colored left border and icon:
- **Note** (blue) — `Ctrl+Shift+N`
- **Tip** (green)
- **Important** (purple)
- **Caution** (yellow)
- **Warning** (red)

### Code Blocks

- **70+ languages** with syntax highlighting (Refractor)
- **Language dropdown** — select or auto-detect language from content
- **Line numbers**
- **Copy button** — one-click copy code to clipboard
- Dark / light theme aware

### Tables

- Insert via slash menu or toolbar
- **Add / delete rows and columns**
- **Merge and split cells**
- **Toggle header row**
- **Column alignment** (left, center, right)
- **Sort by column** (ascending / descending)
- **Row & column selection** with grip handles
- **Move rows and columns** via grip toolbar
- **Table word wrap** toggle
- **Keyword badges** — highlights `TRUE`, `FALSE`, `NULL`, `N/A`, `Yes`, `No`, etc. with colored pills
- **Export table to CSV** — with smart delimiter detection (comma or semicolon based on locale)

### Math (KaTeX / LaTeX)

- **Inline math**: `$E = mc^2$`
- **Block math**: `$$...$$`
- Live rendering with KaTeX

### Mermaid Diagrams

Render Mermaid diagrams directly in the editor:
- Flowcharts, sequence diagrams, Gantt charts, and more
- Dark / light theme support
- Rendered in exports (HTML and PDF)

### Images

- **Drag & drop** from file system
- **Paste** from clipboard
- **Image toolbar** — width/height controls
- **Insert via slash menu** — by URL or file picker
- Formats: PNG, JPEG, GIF, SVG, WebP, BMP, ICO

### Other Block Types

- **Horizontal rule** — divider line
- **Collapsible sections** — `<details>` / `<summary>` blocks
- **Frontmatter** — YAML metadata block at document start, displayed as a styled table
- **Footnotes** — `[^label]` references with definitions
- **HTML blocks** — raw HTML editing
- **HTML comments** — hidden comments with compact icon
- **Draw.io diagrams** — embedded diagram editing
- **Table of Contents** — `[[_TOC_]]` block with auto-generated heading list
- **Emoji** — `:shortcode:` with visual rendering

### Inline Elements

- **Footnote references** — `[^1]`
- **Hard breaks** — `Shift+Enter`
- **Inline diff** — `{+ added +}` / `{- removed -}` (GitLab syntax)
- **HTML inline tags** — `<kbd>`, `<sub>`, `<sup>`, `<abbr>`, `<var>`, `<samp>`, `<small>`, `<ruby>`

### Smart Typography

- `->` → arrow
- `--` → en-dash
- `...` → ellipsis

---

## Table of Contents Sidebar

- Auto-generated from document headings
- Live updates as you type
- Click to navigate to any section
- Toggle with `Ctrl+Shift+T` or the header button

---

## Export

### HTML

- Standalone HTML file with embedded CSS
- Light and Dark themes
- All content rendered: code highlighting, Mermaid diagrams, math, footnotes, images, frontmatter
- Images exported alongside HTML in a folder when needed

### PDF

- Direct PDF generation via pdfmake
- Light and Dark themes
- Syntax-highlighted code blocks
- Rendered Mermaid diagrams and math equations
- Embedded images
- Auto landscape pages for wide tables
- Footnotes, frontmatter, keyword badges — all preserved
- Page numbers in footer

### CSV

- Export any table to CSV from the table grip toolbar
- Smart delimiter: auto-detects comma or semicolon based on system locale
- Configurable via `inlineMd.csvDelimiter` setting
- UTF-8 BOM for proper encoding in Excel

---

## AI Integration

- **Change detection** — highlights blocks modified by external tools (e.g. AI assistants)
- **Shimmer animation** on actively changing blocks
- **Gradient gutter** — visual indicator for modified/added lines
- **Summary toast** with jump-to-changes

---

## VS Code Integration

### Commands

| Command | Description |
|---------|-------------|
| `Open with MdPre-zalman` | Open current markdown file in WYSIWYG mode |
| `Export to HTML (Light)` | Export as HTML with light theme |
| `Export to HTML (Dark)` | Export as HTML with dark theme |
| `Export to PDF (Light)` | Export as PDF with light theme |
| `Export to PDF (Dark)` | Export as PDF with dark theme |

### Supported File Types

- `.md`
- `.markdown`
- `.mdx`

### Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `inlineMd.csvDelimiter` | CSV delimiter: `,`, `;`, or `auto` | `auto` |

### Per-File Settings

Add an HTML comment at the top of your markdown file:

```markdown
<!-- fullWidth: true tocVisible: true tableWrap: false -->
```

- `fullWidth` — expand editor to full width
- `tocVisible` — show table of contents sidebar
- `tableWrap` — enable table word wrap

---

## Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Bold | `Ctrl+B` |
| Italic | `Ctrl+I` |
| Underline | `Ctrl+U` |
| Strikethrough | `Ctrl+D` |
| Inline Code | `Ctrl+E` |
| Highlight | `Ctrl+Shift+H` |
| Link | `Ctrl+K` |
| Heading 1–4 | `Ctrl+Shift+1` – `Ctrl+Shift+4` |
| Paragraph | `Ctrl+Shift+0` |
| Checkbox List | `Ctrl+Shift+7` |
| Bullet List | `Ctrl+Shift+8` |
| Ordered List | `Ctrl+Shift+9` |
| Blockquote | `Ctrl+Shift+B` |
| Note Callout | `Ctrl+Shift+N` |
| Find & Replace | `Ctrl+F` |
| Source Mode | `Ctrl+/` |
| Table of Contents | `Ctrl+Shift+T` |
| Move Block Up | `Ctrl+Alt+↑` |
| Move Block Down | `Ctrl+Alt+↓` |
| Hard Break | `Shift+Enter` |
| Slash Menu | `/` |
| Save | `Ctrl+S` |

---

## License

MIT
