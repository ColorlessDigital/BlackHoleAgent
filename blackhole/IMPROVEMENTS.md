# BlackHole 프로젝트 기술 개선 및 무결성 검증 요약서

본 문서는 `d:\BlackHole\blackhole` 프로젝트를 대상으로 수행된 구조 개선, 결함 디버깅, 테스트 검증, 그리고 빌드 릴리스 정비 작업에 대한 객관적 사실을 기술한 문서입니다.

---

## 1. 시스템 구조 및 리팩토링 사항

### 1.1 프론트엔드 코드 모듈화 및 비즈니스 로직 분리
* **대형 단일 파일 해체**: 기존 약 2,900줄 규모의 단일 파일 `frontend/src/App.jsx`를 7개의 세부 기능별 커스텀 훅(Hook)과 6개의 전용 React 컴포넌트로 해체 및 리팩토링하였습니다.
* **하위 커스텀 훅 구조**:
  - `useLayoutState.js`: 사이드바 토글, 메인 패널 분할 리사이징 제어, 파일 첨부 수집 상태 관리.
  - `useWorkspaceState.js`: 작업 디렉토리 절대경로 조회, 변경 다이얼로그 호출, 파일 트리 로드 및 탐색.
  - `useSessionState.js`: 대화 히스토리 목록 조회, 신규 세션 생성, 특정 세션 로딩 및 세션 영구 저장/삭제.
  - `useRuntimeState.js`: Llama.cpp 서버 기동/중지, 로컬 GGUF 모델 검색 및 설정 데이터 로드/저장.
  - `useIdeState.js`: 시스템 내 설치된 IDE 스캔 및 BlackHole 전용 확장 통합 기동 제어.
  - `useCollaborationState.js`: 다중 에이전트 협업 시뮬레이터 주제 전달 및 에이전트별 메시지 제어.
  - `useChatState.js`: 1인 브레인 챗 메시지 송수신, SSE 실시간 로그 및 보안 UAC 승인 상태 대기 제어.
* **통합자 훅 도입**: [useAppState.js](file:///d:/BlackHole/blackhole/frontend/src/hooks/useAppState.js)를 구축하여 위의 커스텀 훅들을 병합 및 조립하였으며, 기존 UI와의 호환성을 유지하여 반환하도록 설계했습니다.
* **컴포넌트 분리**: `frontend/src/components/` 디렉토리 하위에 `ChatPanel.jsx`, `FileExplorer.jsx`, `CodeSandbox.jsx`, `TerminalPanel.jsx`, `SettingsModal.jsx`, `SecurityGate.jsx`를 분리 정의하였습니다.

### 1.2 API 통신 채널 정상화 및 레거시 제거
* **API Prefix 누락 픽스**: `frontend/src/api/client.js`에서 백엔드 통신 경로인 `/api` 접두사 누락으로 발생하던 HTML(404 Page) 수신 및 파싱 에러를 API 주소 조합 로직 수정을 통해 정상화했습니다.
* **Ollama 의존성 제거**: `resources/bin` 디렉토리 아래 적재되어 있던 미사용 Ollama 실행파일 및 GPU 드라이버 종속 라이브러리(약 3.02GB)를 삭제하여 배포 디렉토리 용량을 약 104MB 크기로 경량화했습니다. UI에 잔존하던 Ollama 제어 관련 코드 및 초기 체크리스트 텍스트를 `Llama.cpp` 및 `GGUF` 기준으로 정돈하였습니다.

---

## 2. 신규 제어 로직 및 엔진 고도화

### 2.1 Llama.cpp 기동 제어 및 5중 사전 진단 (Preflight Check)
* **사전 진단 추가**: [llamaCppRuntime.js](file:///d:/BlackHole/blackhole/src/runtime/llamaCppRuntime.js) 내에 `preflightCheck(overrides)` 메서드를 신설하여 서버 구동 전 아래 5가지 상태를 사전에 확인하고 예외를 처리하도록 하였습니다.
  1. **GGUF 모델 미선택**: `llamaCppModelPath` 설정 값 누락 여부
  2. **GGUF 모델 파일 유실**: 지정된 모델 경로의 실제 존재 여부
  3. **llama-server.exe 누락**: 바이너리 파일 경로 유효성 검사
  4. **TCP 포트 충돌**: 지정된 포트를 이미 점유 중인 외부 프로세스 감지
  5. **기존 서버 구동 감지**: 포트가 점유 중일 때, Llama.cpp `/health` 응답 성공 시 추가 기동 없이 즉시 바인딩 처리
* **프로세스 에러 전파**: `executor.js` 실행부에 `try-catch` 안전 가드를 배치하여 Preflight Check 에러 메시지가 JSON 응답 본문을 통해 UI 콘솔에 한글 조치 가이드 문구로 전파되도록 하였습니다.
* **VRAM 부족 감지 및 Auto CPU Fallback**: GPU 구동 시 에러 로그(`llama_server.log`)의 최근 15줄을 읽어 `OutOfDeviceMemory`, `failed to allocate Vulkan` 등의 VRAM 부족 예외가 발생할 경우, 자동으로 `--n-gpu-layers 0` (CPU 전용 모드)으로 변수를 스위칭하여 재기동하는 Fallback 메커니즘을 이식했습니다.
* **TCP 포트 추적 기반 Llama 강제 종료**: Llama 프로세스 객체가 Node 메모리에서 소거되더라도 지정 포트를 잡고 있는 실제 PID를 `C:\Windows\System32\netstat.exe`를 통해 역추적하고 `taskkill.exe /F /PID <pid>`를 실행하여 포트 점유 누수를 방지하도록 했습니다.

### 2.2 다중 도구 호출 (Queue) 및 실행 루프 체계화
* **도구 큐 파서**: [toolParser.js](file:///d:/BlackHole/blackhole/src/agent/toolParser.js)에 단일 LLM 출력 내의 모든 도구 태그를 인덱스 순서대로 추출하여 배열로 반환하는 `parseAllToolCalls`를 구현했습니다.
* **Orchestrator 파이프라인**: [orchestrator.js](file:///d:/BlackHole/blackhole/src/agent/orchestrator.js)가 추출된 도구 호출 배열을 순차적인 대기 큐(Queue) 구조로 실행하며, ReAct 메커니즘에 따라 각 도구 실행 결과를 누적 피드백하여 다음 계획 수립에 반영할 수 있도록 구성했습니다.

### 2.3 RAG 검색 가중치 스코어링 고도화
* **수정 시간(mtimeMs) 수집**: [worker.js](file:///d:/BlackHole/blackhole/src/rag/worker.js)에서 파일 스캔 시 각 파일의 최종 수정 타임스탬프(`mtimeMs`)를 캐시에 포함하도록 개선했습니다.
* **가중치 채점 모델**: [indexer.js](file:///d:/BlackHole/blackhole/src/rag/indexer.js) 내 `search` 메서드의 매칭 신뢰성 기준을 다음과 같이 구성했습니다.
  - 파일명 완전 일치 보너스: `+100` 점수 가산
  - 파일명 접두사(StartsWith) 일치 보너스: `+40` 점수 가산
  - 1시간 내 수정 파일: `+50` / 24시간 내 수정 파일: `+20` 점수 가산
  - 코드 심볼 선언문(`class`, `function` 등) 내에 검색어가 포함된 명칭 매칭 시 라인당 추가 가치 점수 계산

---

## 3. UI 회귀 문제 및 스크립트 수정 내역

### 3.1 기능 작동 결함 수정
* **세션 저장 에러**: `App.jsx`에서 `handleSaveSession`을 호출할 때 UI의 `messages` 배열 상태를 직접 바인딩하도록 `onClick={() => handleSaveSession(messages)}` 로 구조화하여 클릭 이벤트 객체가 메시지 데이터에 주입되던 오류를 해결했습니다.
* **기억 지침 추가 에러**: `SettingsModal.jsx` 내 `handleAddMemory` 클릭 및 엔터 키 실행 시 `newMemoryInput` 및 `setNewMemoryInput` 상태 값을 인자로 넘겨 trim 에러가 나던 문제를 해결했습니다.
* **첨부파일 전송 유실**: `ChatPanel.jsx`에서 `handleSendMessage` 호출 시 첨부 파일 배열(`attachments`)과 입력값 소거 함수(`() => setAttachments([])`)를 파라미터로 명시 전달하게 하여 `/api/chat` 본문에 첨부 데이터가 유실되지 않도록 연계했습니다.
* **useAppState 린트 오류**: 훅 참조 순서 불일치로 인한 ESLint 에러를 `useRef`로 참조한 뒤 `useEffect`를 통해 대입받는 위임 함수 형태로 변경하여 해결했습니다.

### 3.2 파일 시스템 및 패키징 정리
* **루트 가비지 제거**: 작업 도중 실수로 루트 폴더에 기록된 0바이트 파일 `{}`을 물리적으로 삭제했습니다.
* **package.json 빌드 동기화**: `package.json`의 `build.files` 배열에서 로컬 개발용 config인 `"config.json"` 항목을 소거하여 일치시켰습니다.

---

## 4. 품질 검증 및 빌드 결과

### 4.1 자동화 단위 테스트 결과
Node.js 내장 테스트 러너(`node --test`)를 통해 작성된 5개 도메인의 단위 테스트(총 21개 서브 테스트 케이스)를 정상 통과했습니다.
* **테스트 대상 파일**:
  - `src/agent/toolParser.test.js` (단일 파싱 및 다중 도구 큐 추출 검증)
  - `src/agent/orchestrator.test.js` (모킹 처리 기반 에이전트 실행 루프 및 컨텍스트 피드백 검증)
  - `src/config/configStore.test.js` (설정 저장, 병합 및 Ollama 레거시 호환 정상화 검증)
  - `src/workspace/fileBroker.test.js` (파일 쓰기/읽기/패치/라인 정밀 치환 기능 검증)
  - `src/workspace/terminalBroker.test.js` (명령어 가동, 타임아웃 종료 가드 및 버퍼 초과 차단 검증)
* **테스트 결과 요약**:
  ```
  # tests 21
  # suites 3
  # pass 21
  # fail 0
  # duration_ms 575.62
  ```

### 4.2 릴리스 품질 검사 자동화 (`release-check.js`)
* **스크립트 기능**: 빌드 및 배포 패키징을 시도하기 전, 일관된 품질을 점검하기 위한 [release-check.js](file:///d:/BlackHole/blackhole/scripts/release-check.js)를 신설했습니다.
* **스캔 프로세스**:
  1. `check-backend.js` 실행 (백엔드 모든 소스파일 Syntax 오류 여부 검사)
  2. `npm test` 실행 (21개 단위 테스트 무결성 점검)
  3. `eslint` 실행 (프론트엔드 코드의 문법 검사)
  4. 내장 `llama-server.exe` 리소스 유실 여부 검증
  5. 루트 가비지 파일 `{}` 검사
  6. `package.json` build.files 동기화 점검
  7. `vite build` 가동을 통한 프론트엔드 production 컴파일 성공 검증

### 4.3 Electron 인스톨러 빌드 및 디지털 서명
* **Vite 컴파일**: 프론트엔드가 에러 없이 컴파일되었습니다.
* **nsis 패키징**: `electron-builder`를 통하여 설치 파일 `dist\BlackHole-Setup.exe` 및 무설치 폴더 `dist\win-unpacked` 생성을 마쳤습니다.
* **디지털 서명**: Windows 자체 BlackHole CA 및 서명 스크립트(`scripts/sign-release.ps1`)를 통하여 `BlackHole.exe` 및 `BlackHole-Setup.exe` 모두 유효한 전자서명(`Status: Valid`) 획득을 검증 완료했습니다.
