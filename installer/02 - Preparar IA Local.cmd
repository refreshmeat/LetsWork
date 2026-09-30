@echo off
setlocal
chcp 65001 >nul
title LetsWork v0.1 - Preparar IA Local

echo.
echo ==========================================
echo   LetsWork v0.1 - Preparacao da IA local
echo ==========================================
echo.
echo Este processo instala o Ollama quando necessario
echo e baixa o modelo llama3.2:3b (aprox. 2 GB).
echo.

set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"

if exist "%OLLAMA_EXE%" goto :MODEL
where ollama >nul 2>&1
if not errorlevel 1 (
  set "OLLAMA_EXE=ollama"
  goto :MODEL
)

where winget >nul 2>&1
if errorlevel 1 goto :MANUAL

echo Instalando Ollama...
winget install --id Ollama.Ollama --exact --accept-package-agreements --accept-source-agreements
if errorlevel 1 goto :MANUAL

set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
if not exist "%OLLAMA_EXE%" (
  where ollama >nul 2>&1
  if errorlevel 1 goto :MANUAL
  set "OLLAMA_EXE=ollama"
)

:MODEL
echo.
echo Iniciando servico local da IA...
start "" /min "%OLLAMA_EXE%" serve
timeout /t 3 /nobreak >nul

echo.
echo Verificando modelo...
"%OLLAMA_EXE%" list 2>nul | findstr /i /c:"llama3.2:3b" >nul
if not errorlevel 1 goto :OK

echo Baixando llama3.2:3b. Isso pode demorar dependendo da internet...
"%OLLAMA_EXE%" pull llama3.2:3b
if errorlevel 1 goto :FAIL

:OK
echo.
echo ==========================================
echo IA local pronta.
echo Agora abra o LetsWork pelo atalho da Area de Trabalho.
echo ==========================================
echo.
pause
exit /b 0

:MANUAL
echo.
echo Nao foi possivel instalar o Ollama automaticamente.
echo Abrindo a pagina oficial para instalacao manual...
start "" "https://ollama.com/download/windows"
echo.
echo Depois de instalar o Ollama, execute este arquivo novamente.
pause
exit /b 1

:FAIL
echo.
echo O Ollama foi encontrado, mas o modelo nao terminou de baixar.
echo Verifique a internet e execute este arquivo novamente.
pause
exit /b 1
