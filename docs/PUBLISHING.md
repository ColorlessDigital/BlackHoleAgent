# GitHub Presentation and Publishing

Repository: [ColorlessDigital/BlackHoleAgent](https://github.com/ColorlessDigital/BlackHoleAgent).
Project page: [GitHub Pages](https://colorlessdigital.github.io/BlackHoleAgent/).
Use this guide for initial publication and later updates; check Pages/Actions
and Releases for their actual deployment state.

## Repository Front Page

The root README.md is the primary English introduction. Keep `docs/images`
alongside it so relative image paths resolve. Uploading README alone omits its
images. Relative links avoid assumptions about a fork's owner or branch.

Official reference: [About READMEs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes).

## GitHub Pages

`docs/index.html`, `docs/styles.css`, `docs/site.js` and `docs/images` form a
buildless static site. It includes `.nojekyll` and does not use analytics,
external fonts, credentials or real provider calls.

After publication authority and the public scope are confirmed:

1. Push only the audited public source. Do not reuse the original private Git
   history, runtime data or private backup.
2. In Settings → Pages, select `Deploy from a branch`.
3. Select the actual source branch and `/docs` publishing directory.
4. Verify the deployment status and the actual URL returned by GitHub.

Official reference: [Configure a Pages publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

No extra automatic publishing workflow was added. Preparing a file is not, by
itself, authorization to publish it.

## Release Assets and Documentation Updates

Executable assets belong in GitHub Releases, not the source history. Keep
SHA-256 verification and explicit warnings for development prereleases.
Preserve existing tags and binary assets when only documentation changes.
An additional English-source archive can identify the newer documentation commit
without moving the tag of an existing binary release.

## Pre-Publication Checklist

- Exclude credentials, personal conversations, config/data, diagnostics,
  certificates, private backups and original private Git history.
- Keep the scripted-demo labels and image provenance statements.
- Review public author/publisher attribution and technical summaries.
- Review known audit findings and unverified scopes in PUBLIC_VALIDATION.json.
- Retain LICENSE, NOTICE, dependency terms, images, tests and lockfiles.

Documentation localization does not modify prompts, censorship or approval policy.
