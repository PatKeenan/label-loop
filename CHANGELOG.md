# Changelog

## [0.3.0](https://github.com/PatKeenan/label-loop/compare/v0.2.0...v0.3.0) (2026-09-04)


### ⚠ BREAKING CHANGES

* **db:** every judge scores, and polarity becomes two-valued ([#35](https://github.com/PatKeenan/label-loop/issues/35))

### Features

* **db:** every judge scores, and polarity becomes two-valued ([#35](https://github.com/PatKeenan/label-loop/issues/35)) ([4d90658](https://github.com/PatKeenan/label-loop/commit/4d906587528ddb058c10d2f08c1ba41d4d5e907e))
* **db:** freeze the capability pin onto judge_versions ([#29](https://github.com/PatKeenan/label-loop/issues/29)) ([f3683ff](https://github.com/PatKeenan/label-loop/commit/f3683ff602c70b322bd6aa532940a56f9cc79293))
* **db:** put tokens and money on every persisted verdict ([#28](https://github.com/PatKeenan/label-loop/issues/28)) ([c7f8629](https://github.com/PatKeenan/label-loop/commit/c7f862969e4f2a1d741d2b1ba7632f0d39b7f9e7))
* **llm:** add the OpenRouter adapter behind the existing port ([#27](https://github.com/PatKeenan/label-loop/issues/27)) ([55a7826](https://github.com/PatKeenan/label-loop/commit/55a78268bde9164db71615d33fb5494c2faed1b8))
* **llm:** pin a capability contract, and give an unfixable provider failure its own kind ([#25](https://github.com/PatKeenan/label-loop/issues/25)) ([7c7d717](https://github.com/PatKeenan/label-loop/commit/7c7d7176899a98453fadca0080157d4f247341b1))
* **seed:** pin three real models, and tell the judge how long a rationale is ([#31](https://github.com/PatKeenan/label-loop/issues/31)) ([523b1df](https://github.com/PatKeenan/label-loop/commit/523b1dfbdc73f3c16b6b40432913c5c3a35bc57e))


### Bug Fixes

* **llm:** keep the provider's payload out of log lines and spans ([#26](https://github.com/PatKeenan/label-loop/issues/26)) ([2debc14](https://github.com/PatKeenan/label-loop/commit/2debc149d882f7bf0999a19452d2a532f47e37dd))


### Documentation

* **adr:** every judge scores, and classification leaves the product ([#32](https://github.com/PatKeenan/label-loop/issues/32)) ([553629d](https://github.com/PatKeenan/label-loop/commit/553629d4319e84588739c74a8c4bb6dda931bd18))
* **adr:** pin judge versions to a capability contract, and fix data collection to deny ([#23](https://github.com/PatKeenan/label-loop/issues/23)) ([05d5a50](https://github.com/PatKeenan/label-loop/commit/05d5a503bf401de9c75c07306bccdd575b143822))
* **adr:** route M1 judge inference through OpenRouter, for this phase only ([#21](https://github.com/PatKeenan/label-loop/issues/21)) ([e332b08](https://github.com/PatKeenan/label-loop/commit/e332b087da025daf056ec4d77588f336e23296cf))
* **adr:** version the judge's authored prompt and its compilation template ([#30](https://github.com/PatKeenan/label-loop/issues/30)) ([d8350fe](https://github.com/PatKeenan/label-loop/commit/d8350fe30ff789441cf5631b3cd6a01deaca2011))
* **plan:** approve the M1 endpoint spine (+ ADR 0024..0029) ([#24](https://github.com/PatKeenan/label-loop/issues/24)) ([306ebb9](https://github.com/PatKeenan/label-loop/commit/306ebb9525a530ea84317f5f783f16389773f947))
* **plan:** approve the P3 prose sweep, and defer the P2 seeded panel ([#37](https://github.com/PatKeenan/label-loop/issues/37)) ([9f9c575](https://github.com/PatKeenan/label-loop/commit/9f9c57545be59c6260bcbfb920bdc2eb6fa3736f))
* **plan:** complete the M0 and M1 plans, and give M5 its polarity prerequisite ([#34](https://github.com/PatKeenan/label-loop/issues/34)) ([5bffaa4](https://github.com/PatKeenan/label-loop/commit/5bffaa4215a71d0b865334f01f438cac0043dae0))
* **plan:** complete the P1 two-valued-polarity plan ([#36](https://github.com/PatKeenan/label-loop/issues/36)) ([68341db](https://github.com/PatKeenan/label-loop/commit/68341db8a5de5e2f1ca75bb744704e79be0dcc0d))
* **plan:** record the M0 release as shipped ([#20](https://github.com/PatKeenan/label-loop/issues/20)) ([14c80cc](https://github.com/PatKeenan/label-loop/commit/14c80cc9d457681704c195d7dd1983bd71548991))
* polarity is two-valued, and classification leaves the product ([#39](https://github.com/PatKeenan/label-loop/issues/39)) ([15ab1f6](https://github.com/PatKeenan/label-loop/commit/15ab1f698ef8fd947b4e8172b2ab7931164f0926))


### Build & Dependencies

* **deps:** bump fast-uri to 3.1.6, clearing four high advisories ([#38](https://github.com/PatKeenan/label-loop/issues/38)) ([9ea0dea](https://github.com/PatKeenan/label-loop/commit/9ea0deaeb24c289c8d631c46d1871d9f49529e48))

## [0.2.0](https://github.com/PatKeenan/label-loop/compare/v0.1.0...v0.2.0) (2026-08-29)


### ⚠ BREAKING CHANGES

* **contracts:** taxonomy-coded reasons, confidence, and judges keyed by slug ([#12](https://github.com/PatKeenan/label-loop/issues/12))
* **contracts:** replace the classifier with a panel of judges ([#10](https://github.com/PatKeenan/label-loop/issues/10))

### Features

* **api:** boot the API with the error, logging and lifecycle patterns ([#9](https://github.com/PatKeenan/label-loop/issues/9)) ([4076ddf](https://github.com/PatKeenan/label-loop/commit/4076ddffdadd6bf44d9e1a2106fd1ab1dfee736f))
* **api:** hand-written spans, a Grafana stack of four, and a request_id that is the trace id ([#16](https://github.com/PatKeenan/label-loop/issues/16)) ([be5bbc3](https://github.com/PatKeenan/label-loop/commit/be5bbc3a91c51d61e189985eac03a2cc72d85349))
* **api:** the queue seam — idempotent jobs, an attempt ledger we own, and a drain that waits ([#15](https://github.com/PatKeenan/label-loop/issues/15)) ([d9b4bf1](https://github.com/PatKeenan/label-loop/commit/d9b4bf16fbdd56c4106b754806eba06bffaf1b1f))
* **api:** the steel thread — a panel of judges, behind one gateway ([#14](https://github.com/PatKeenan/label-loop/issues/14)) ([749d738](https://github.com/PatKeenan/label-loop/commit/749d738c18798d83bcd00ba6b61f538ba2d664fe))
* **contracts:** error taxonomy, envelope, prefixed ids, and classify schemas ([#7](https://github.com/PatKeenan/label-loop/issues/7)) ([59e13ea](https://github.com/PatKeenan/label-loop/commit/59e13ea7690a5f3ab817e43371098e9851d88f74))
* **contracts:** replace the classifier with a panel of judges ([#10](https://github.com/PatKeenan/label-loop/issues/10)) ([20e0eec](https://github.com/PatKeenan/label-loop/commit/20e0eec541a85b48924d3cc609871480ce0db3df))
* **contracts:** taxonomy-coded reasons, confidence, and judges keyed by slug ([#12](https://github.com/PatKeenan/label-loop/issues/12)) ([566db31](https://github.com/PatKeenan/label-loop/commit/566db31a9850ecfd026878ec21c12aeb385a4199))
* **db:** the schema, two Postgres roles, and rules the database enforces rather than trusts ([#13](https://github.com/PatKeenan/label-loop/issues/13)) ([8d7566a](https://github.com/PatKeenan/label-loop/commit/8d7566ab2a8fbf0b9ac6f49ff902566ba16e9d62))
* **infra:** one command, and the guts stay visible — images, compose, k6, full CI ([#19](https://github.com/PatKeenan/label-loop/issues/19)) ([3c1f8b1](https://github.com/PatKeenan/label-loop/commit/3c1f8b145622f4b5674d306fead1b4ed126fceac))
* **web:** the console — a real session, a typed RPC surface, and an error map that cannot drift ([#17](https://github.com/PatKeenan/label-loop/issues/17)) ([eb6ad6a](https://github.com/PatKeenan/label-loop/commit/eb6ad6a57517d55c03c098a6e7154f20a9ff92a7))


### Bug Fixes

* **ci:** lint the PR title with the suffix the squash merge adds ([#18](https://github.com/PatKeenan/label-loop/issues/18)) ([5e1ac78](https://github.com/PatKeenan/label-loop/commit/5e1ac7863113532b4ace1f6615358b74db08df97))


### Documentation

* **plan:** correct the P0 deviation record for subject-case ([826a875](https://github.com/PatKeenan/label-loop/commit/826a87517056487112618790adb9ad95259d00d8))
* **process:** require feature branches and PRs for all new code ([#8](https://github.com/PatKeenan/label-loop/issues/8)) ([596dba1](https://github.com/PatKeenan/label-loop/commit/596dba1d030241bf107ec32da1364e7b11acd545))
* **product:** reconcile the parallel planning session, and make billing two-sided ([#11](https://github.com/PatKeenan/label-loop/issues/11)) ([76dda04](https://github.com/PatKeenan/label-loop/commit/76dda04046b4248c9a5823c7adb02c2532bc736a))


### CI

* Bump actions/checkout from 6 to 7 ([#3](https://github.com/PatKeenan/label-loop/issues/3)) ([b7fc9e2](https://github.com/PatKeenan/label-loop/commit/b7fc9e256a729307aabedac1d1c0bc180b5178d3))
* bump gitleaks/gitleaks-action from 2 to 3 ([#1](https://github.com/PatKeenan/label-loop/issues/1)) ([a6fc63a](https://github.com/PatKeenan/label-loop/commit/a6fc63ad1bd1f8b66d49c78fb10114fe23ac9a1a))
* bump googleapis/release-please-action from 4 to 5 ([#2](https://github.com/PatKeenan/label-loop/issues/2)) ([64efd45](https://github.com/PatKeenan/label-loop/commit/64efd45266ed35a53bad9f37e36079ae8dcaba56))

## 0.1.0 (2026-08-22)


### Bug Fixes

* **ci:** do not cancel in-progress PR title runs ([1ae4231](https://github.com/PatKeenan/label-loop/commit/1ae423191301fe5363ba1a32b86f13e327da9834))
* **ci:** normalise and lint the PR title in one job ([6af90ef](https://github.com/PatKeenan/label-loop/commit/6af90ef71ed104775d0c266e54aba7696b3de721))
* **ci:** relax subject-case and stop rewriting bot PR titles ([1a30e8e](https://github.com/PatKeenan/label-loop/commit/1a30e8ee8bf895cd561457651ea0fd7e349c7250))
* **p0:** make hook install survive a missing git dir ([eb30bc8](https://github.com/PatKeenan/label-loop/commit/eb30bc80ccaa693e6388abfcff0536b53f60f470))


### Documentation

* add M0 walking skeleton implementation plan ([5a6ac50](https://github.com/PatKeenan/label-loop/commit/5a6ac50f061ff31113e87c0a61a90b299f97be95))
* add product overview README ([3bf6563](https://github.com/PatKeenan/label-loop/commit/3bf6563d5011ab7778191184e737f800aa68c7d6))
* initial commit — product spine, ADRs 0001-0011, M0 research ([c27a2be](https://github.com/PatKeenan/label-loop/commit/c27a2be9cb55789e0cb59dafd56acee55671e9b1))
* **plan:** record P0 progress and the PR-title linting change ([f3509cf](https://github.com/PatKeenan/label-loop/commit/f3509cf2c3ee240633a74c2cb117cba87d5622b6))


### Build & Dependencies

* **p0:** repo genesis — Bun workspaces, Biome, commitlint, CI, release-please ([fcd2050](https://github.com/PatKeenan/label-loop/commit/fcd20501af827fde0259a62f1a99a003dd0527a8))


### CI

* lint the pull request title instead of the branch's commits ([f8e57db](https://github.com/PatKeenan/label-loop/commit/f8e57db0006efed229849c6f2619cc0cc5789544))
* **release:** start the version line at 0.1.0, not 1.0.0 ([937a947](https://github.com/PatKeenan/label-loop/commit/937a947334f27a85c5d21eb1bccd43b80b93bbe1))
