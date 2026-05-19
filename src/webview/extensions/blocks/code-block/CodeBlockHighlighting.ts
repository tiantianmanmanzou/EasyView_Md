/**
 * Code highlighting extension using Refractor
 * Copied from Outline's shared/editor/extensions/CodeHighlighting.ts
 */

import flattenDeep from "lodash/flattenDeep";
import padStart from "lodash/padStart";
import type { Node } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import refractor from "refractor/core";
import { getLoaderForLanguage, getRefractorLangForLanguage } from "../../../editor/lib/CodeLanguages";
import { isCode, isMermaid } from "../../../editor/lib/CodeDetection";
import { findBlockNodes } from "../../../editor/lib/NodeFinder";

type ParsedNode = {
  text: string;
  classes: string[];
};

const cache: Record<number, { node: Node; decorations: Decoration[] }> = {};
const languagesToImport = new Set<string>();
const languagePromises: Record<
  string,
  Promise<string | undefined> | undefined
> = {};

async function loadLanguage(language: string) {
  if (!language || refractor.registered(language)) {
    return;
  }

  if (languagePromises[language]) {
    return languagePromises[language];
  }

  const loader = getLoaderForLanguage(language);
  if (!loader) {
    return;
  }

  languagePromises[language] = loader()
    .then((syntax) => {
      refractor.register(syntax);
      return language;
    })
    .catch((err) => {
      // It will retry loading the language on the next render
      console.error(
        `[CodeHighlighting] Failed to load language ${language}`,
        err
      );
      delete languagePromises[language]; // Remove failed promise from cache
      return undefined;
    });

  return languagePromises[language];
}

function getDecorations({
  doc,
  name,
  lineNumbers,
}: {
  /** The prosemirror document to operate on. */
  doc: Node;
  /** The node name. */
  name: string;
  /** Whether to include decorations representing line numbers */
  lineNumbers?: boolean;
}) {
  const decorations: Decoration[] = [];
  const blocks: { node: Node; pos: number }[] = findBlockNodes(
    doc,
    true
  ).filter((item) => isCode(item.node) && !isMermaid(item.node));

  function parseNodes(
    nodes: refractor.RefractorNode[],
    classNames: string[] = []
  ): {
    text: string;
    classes: string[];
  }[] {
    return flattenDeep(
      nodes.map((node) => {
        if (node.type === "element") {
          const classes = [...classNames, ...(node.properties.className || [])];
          return parseNodes(node.children, classes);
        }

        return {
          text: node.value,
          classes: classNames,
        };
      })
    );
  }

  blocks.forEach((block) => {
    let startPos = block.pos + 1;
    const language = block.node.attrs.language;
    const lang = getRefractorLangForLanguage(language);
    const lineDecorations = [];

    // Check if we need to recalculate:
    // - No cache
    // - Node changed
    // - Language just registered (wasn't highlighted before)
    const needsRecalc = !cache[block.pos] ||
                        !cache[block.pos].node.eq(block.node) ||
                        (lang && refractor.registered(lang) && !cache[block.pos].highlighted);

    if (needsRecalc) {
      if (lineNumbers) {
        const lineCount =
          (block.node.textContent.match(/\n/g) || []).length + 1;
        const gutterWidth = String(lineCount).length;

        const lineCountText = new Array(lineCount)
          .fill(0)
          .map((_, i) => padStart(`${i + 1}`, gutterWidth, " "))
          .join("\n");

        lineDecorations.push(
          Decoration.node(
            block.pos,
            block.pos + block.node.nodeSize,
            {
              "data-line-numbers": `${lineCountText}`,
              style: `--line-number-gutter-width: ${gutterWidth};`,
            },
            {
              key: `line-${lineCount}-gutter`,
            }
          )
        );
      }

      cache[block.pos] = {
        node: block.node,
        decorations: lineDecorations,
        highlighted: false,
      };

      if (!lang) {
        // No refractor language mapping found
      } else if (refractor.registered(lang)) {
        languagesToImport.delete(language);
        const nodes = refractor.highlight(block.node.textContent, lang);
        const newDecorations = parseNodes(nodes)
          .map((node: ParsedNode) => {
            const from = startPos;
            const to = from + node.text.length;

            startPos = to;

            return {
              ...node,
              from,
              to,
            };
          })
          .filter((node) => node.classes && node.classes.length)
          .map((node) =>
            Decoration.inline(node.from, node.to, {
              class: node.classes.join(" "),
            })
          )
          .concat(lineDecorations);

        cache[block.pos] = {
          node: block.node,
          decorations: newDecorations,
          highlighted: true,
        };
      } else {
        languagesToImport.add(language);
      }
    }

    cache[block.pos]?.decorations.forEach((decoration) => {
      decorations.push(decoration);
    });
  });

  Object.keys(cache)
    .filter((pos) => !blocks.find((block) => block.pos === Number(pos)))
    .forEach((pos) => {
      delete cache[Number(pos)];
    });

  return DecorationSet.create(doc, decorations);
}

export function CodeHighlighting({
  name,
  lineNumbers,
}: {
  /** The node name. */
  name: string;
  /** Whether to include decorations representing line numbers */
  lineNumbers?: boolean;
}) {
  let highlighted = false;

  return new Plugin({
    key: new PluginKey("codeHighlighting"),
    state: {
      init: (_, { doc }) => DecorationSet.create(doc, []),
      apply: (transaction: Transaction, decorationSet, oldState, state) => {
        // @ts-expect-error accessing private field.
        const isPaste = transaction.meta?.paste;
        const langLoaded = transaction.getMeta("codeHighlighting")?.langLoaded;

        // Recalculate decorations on any doc change, paste, or language loaded
        if (
          !highlighted ||
          transaction.docChanged ||
          isPaste ||
          langLoaded
        ) {
          highlighted = true;
          return getDecorations({ doc: transaction.doc, name, lineNumbers });
        }

        return decorationSet.map(transaction.mapping, transaction.doc);
      },
    },
    view: (view) => {
      if (!highlighted) {
        // we don't highlight code blocks on the first render as part of mounting
        // as it's expensive (relative to the rest of the document). Instead let
        // it render un-highlighted and then trigger a defered render of highlighting
        // by updating the plugins metadata
        requestAnimationFrame(() => {
          try {
            view.dispatch(
              view.state.tr.setMeta("codeHighlighting", { loaded: true })
            );
          } catch (e) {
            // View might be destroyed
          }
        });
      }
      return {
        update: () => {
          if (!languagesToImport.size) {
            return;
          }

          void Promise.all([...languagesToImport].map(loadLanguage)).then(
            (languages) => {
              if (languages.some(l => l) && languagesToImport.size) {
                try {
                  view.dispatch(
                    view.state.tr.setMeta("codeHighlighting", {
                      langLoaded: languages,
                    })
                  );
                } catch (e) {
                  console.error('[CodeHighlighting] Error dispatching transaction:', e);
                }
              }
            }
          );
        },
      };
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
}
