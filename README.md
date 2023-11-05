# report-h2spec-regressions

A GitHub action to report whenever PR to <https://github.com/hapsoc/fluke>
breaks h2spec tests. Or rather, when the number of passing tests decreases,
which isn't the same as "making sure all the tests that did pass, still pass",
but it's annoying to do that because of GitHub's 90-day expiration delay set on
artifacts.
