# GitHub 표시와 게시 안내

게시 대상: [ColorlessDigital/BlackHoleAgent](https://github.com/ColorlessDigital/BlackHoleAgent).
소개 페이지: [GitHub Pages](https://colorlessdigital.github.io/BlackHoleAgent/).
이 문서는 최초 게시와 이후 재배포에 사용하는 절차입니다. 실제 상태는 저장소의 Pages/Actions에서 확인합니다.

## 저장소 첫 화면

저장소 최상위의 README.md가 소개 문서입니다. `docs/images`를 함께 올려야 상대 경로 이미지가
표시됩니다. README만 단독 업로드하면 이미지가 빠집니다. 저장소 주소·브랜치를 가정한 절대
GitHub URL 대신 상대 경로를 사용했습니다.

공식 안내: [About READMEs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes).

## 별도 GitHub Pages 소개 페이지

`docs/index.html`, `docs/styles.css`, `docs/site.js`, `docs/images`는 빌드 도구가 필요 없는 정적 페이지입니다.
정적 파일에는 분석 도구·외부 폰트·키·실제 공급자 호출이 없습니다. `.nojekyll`도 포함했습니다.

게시 권한과 공개 범위를 확인한 후:

1. 감사한 공개 소스만 저장소에 올립니다. 원래 개발 저장소의 .git이나 비공개 백업을 재사용하지 않습니다.
2. 저장소의 Settings → Pages에서 `Deploy from a branch`를 선택합니다.
3. 실제 소스가 있는 브랜치와 `/docs`를 게시 원본으로 선택합니다.
4. GitHub가 안내하는 실제 배포 URL과 상태를 확인합니다. 이 문서는 공개 주소를 미리 만들어 넣지 않았습니다.

공식 안내: [Pages 게시 원본 설정](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

자동 배포 워크플로는 새로 추가하지 않았습니다. 파일 준비 자체가 게시 승인을 의미하지 않습니다.

## 공개 전 점검

- 개인 대화·키·config/data·원본 진단·인증서·.git·비공개 백업이 없는지 확인합니다.
- 화면이 가상 시연임을 알리는 문구와 이미지 출처 표시를 유지합니다.
- 작성자/publisher·저작권 표시와 기술 요약이 공개된다는 점을 확인합니다.
- `PUBLIC_VALIDATION.json`의 기존 의존성 취약점과 미검증 범위를 검토합니다.
- LICENSE/NOTICE/제3자 라이선스와 이미지·문서·테스트·잠금 파일을 함께 유지합니다.

이 프로젝트의 프롬프트 검열·승인 정책은 문서 작성 과정에서 변경하지 않았습니다.
