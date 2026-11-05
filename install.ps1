# MD Editor 설치 스크립트 (Windows · x64)
#
#   irm https://raw.githubusercontent.com/ReentaKim/md-editor/main/install.ps1 | iex
#
# GitHub 최신 릴리스의 설치 프로그램을 받아 SHA-256을 검증한 뒤 조용히 설치하고 실행한다.
# (관리자 권한 없이 사용자 폴더 %LOCALAPPDATA%\Programs 에 설치된다)
& {
  $ErrorActionPreference = 'Stop'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $repo = 'ReentaKim/md-editor'

  if (-not [Environment]::Is64BitOperatingSystem) { Write-Host '오류: 64비트 Windows 전용입니다.' -ForegroundColor Red; return }

  Write-Host '▸ 최신 버전 확인 중…'
  $rel = Invoke-RestMethod -UseBasicParsing -Headers @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'MD-Editor-Installer' } `
    -Uri "https://api.github.com/repos/$repo/releases/latest"
  $asset = $rel.assets | Where-Object { $_.name -like '*-x64.exe' } | Select-Object -First 1
  if (-not $asset) { Write-Host "오류: $($rel.tag_name) 릴리스에 Windows용 설치 파일이 아직 없습니다. 잠시 후 다시 시도해 주세요." -ForegroundColor Red; return }
  $expected = ($asset.digest -replace '^sha256:', '').ToLower()
  if (-not $expected) { Write-Host '오류: SHA-256 정보가 없어 검증할 수 없습니다.' -ForegroundColor Red; return }

  $file = Join-Path $env:TEMP $asset.name
  Write-Host "▸ MD Editor $($rel.tag_name) 다운로드 중…"
  $ProgressPreference = 'SilentlyContinue'   # 진행 표시가 다운로드를 크게 느리게 하므로 끔
  Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $file

  Write-Host '▸ 파일 검증 중 (SHA-256)…'
  $actual = (Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLower()
  if ($actual -ne $expected) { Remove-Item $file -Force; Write-Host '오류: SHA-256이 일치하지 않습니다. 설치를 중단합니다.' -ForegroundColor Red; return }

  Write-Host '▸ 설치 중…'
  $p = Start-Process -FilePath $file -ArgumentList '/S' -Wait -PassThru
  Remove-Item $file -Force -ErrorAction SilentlyContinue
  if ($p.ExitCode -ne 0) { Write-Host "오류: 설치 프로그램이 실패했습니다 (코드 $($p.ExitCode))." -ForegroundColor Red; return }

  $exe = @('MD Editor', 'md-editor') | ForEach-Object { Join-Path $env:LOCALAPPDATA "Programs\$_\MD Editor.exe" } | Where-Object { Test-Path $_ } | Select-Object -First 1
  Write-Host "✓ MD Editor $($rel.tag_name) 설치 완료" -ForegroundColor Green
  Write-Host '  시작 메뉴와 바탕화면에 바로가기가 만들어졌습니다. 다음 버전부터는 앱 안의 [업데이트] 버튼으로 업데이트할 수 있습니다.'
  if ($exe) { Start-Process -FilePath $exe }
}
