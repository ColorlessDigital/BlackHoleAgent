!macro customInstall
  DetailPrint "Registering BlackHole Root CA Certificate..."
  nsExec::ExecToLog "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command $\"Import-Certificate -FilePath '$INSTDIR\resources\BlackHoleRootCA.cer' -CertStoreLocation 'Cert:\LocalMachine\Root' -ErrorAction SilentlyContinue$\""
!macroend

!macro customUninstall
  DetailPrint "Removing BlackHole Root CA Certificate..."
  nsExec::ExecToLog "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command $\"$$store = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'LocalMachine'); $$store.Open('ReadWrite'); $$certs = Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $$_.Subject -eq 'CN=BlackHole Root CA' }; foreach ($$cert in $$certs) { $$store.Remove($$cert) }; $$store.Close()$\""
!macroend
