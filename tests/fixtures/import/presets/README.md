# Matching presets: where they differ

Statements whose lines each show where the three matching presets (Strict, Balanced, Lenient, in
`plugins/import/src/privileged/matching/tuning.ts`) part ways. Every line is a real pairing a person would make;
`from` names the strictest preset that should propose it:

| `from` | Proposed by |
|---|---|
| `strict` | all three |
| `balanced` | Balanced and Lenient |
| `lenient` | Lenient only |

`tests/plugins/import/matching/presets.test.ts` holds each preset to exactly that, and to proposing the right
transaction. The main corpus (`../corpus`) is what the presets are measured on for precision and recall; these files
show the ladder between them. The file shape is the corpus's, with `from` in place of `expect`'s `null`.
