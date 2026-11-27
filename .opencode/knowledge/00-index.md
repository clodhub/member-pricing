# member-pricing ownership

Repository: https://github.com/clodhub/member-pricing.git.
Current code: `implementation/server/index.ts`, `implementation/server/service.ts`, `implementation/web/index.ts`, `implementation/web/pricing.ts`, `implementation/web/settings.ts`.
`component.json`, `tools.lock.json` and `visual/` are generated from `authoring/spec.json`. Licence documents belong to their respective authors and are included as supplied. `CONTRACT.md`, `INSTRUCTIONS.md` and `SOURCE.md` are hand-written and kept on regeneration.
Every artefact installs under `components/member-pricing/`, which clod places at `components/<slot id>/` of the application; other code reaches this component only through the entry modules in each interface document's `x-clodhub-modules` (paths relative to the component root; set by the scaffolder from `spec.modules`, or from `implementation/<platform>/index.ts` and the native source folders).
