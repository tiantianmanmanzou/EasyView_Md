# OOXML fidelity harness

Fixtures live under `sample/xlsx`, `sample/docx`, `sample/pptx`.
JSON case sketches live under `sample/cases`.

Executable coverage is `packages/node-runtime/src/ai/ooxml-sample-fidelity.test.ts`:
it opens each sample through `DocumentService`, applies one edit, and asserts
untouched OPC parts stay byte-identical after save.
