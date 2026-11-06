# Contributing

Issues and pull requests are welcome.

## License of contributions

This project is MIT-0. By submitting a contribution you agree it is licensed
under MIT-0, the same terms as the project, with no other conditions.

## CodeMirror notes

`ChangeSet.touchesRange(from, to)` (`@codemirror/state`) returns `false`, `true`, or the string `"cover"` when an insertion lands strictly inside `[from, to)`. Test its return value by truthiness rather than `=== true`, and check every change including pure insertions, or `theirs.map(mine)` silently splices concurrent interior insertions into the middle of a replacement.
