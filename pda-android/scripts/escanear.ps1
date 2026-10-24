<#
.SYNOPSIS
  Simula lecturas de escáner en el emulador de Android Studio (o en una PDA por USB) con adb.

.EXAMPLE
  .\escanear.ps1 bonito-caja                  # un código de codigos-demo.txt, por su nombre
  .\escanear.ps1 '0102000000000015<GS>3724'   # un código cualquiera (<GS> = separador GS1)
  .\escanear.ps1 -Modo teclado lote-bonito    # como un lector en modo teclado
  .\escanear.ps1 -Todos                       # todos los de la lista, con pausa
  .\escanear.ps1 -Lista                       # ver la lista

.DESCRIPTION
  Modos:
    intent   (por defecto) Como Zebra DataWedge «Intent output»: llega entero, con GS y simbología.
             Necesita la app Sindri PDA (pda-android) abierta.
    teclado  Como DataWedge «Keystroke», Honeywell en modo teclado o una pistola: teclea el código y
             pulsa Intro. Sirve también con Chrome del emulador. El GS no se puede teclear con adb:
             -Gs texto lo manda como «<GS>» (Sindri lo entiende) y -Gs quitar lo pierde, como una pistola.

  Con varios dispositivos: $env:ANDROID_SERIAL = 'emulator-5554'
#>
param(
  [Parameter(Position = 0, ValueFromRemainingArguments = $true)] [string[]] $Codigos,
  [ValidateSet('intent', 'teclado')] [string] $Modo = 'intent',
  [string] $Simbologia = '',
  [ValidateSet('texto', 'quitar')] [string] $Gs = 'texto',
  [double] $Pausa = 2,
  [switch] $Lista,
  [switch] $Todos
)
$ErrorActionPreference = 'Stop'
$accion = 'com.sindri.pda.ESCANEO'
$paquete = 'com.sindri.pda'

# adb: el del PATH o el del SDK que instala Android Studio.
$adb = (Get-Command adb -ErrorAction SilentlyContinue).Source
if (-not $adb) {
  $sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
  $adb = Join-Path $sdk 'platform-tools\adb.exe'
  if (-not (Test-Path $adb)) { throw "No encuentro adb. Instala «Android SDK Platform-Tools» desde Android Studio." }
}

$filas = Get-Content -Encoding UTF8 (Join-Path $PSScriptRoot 'codigos-demo.txt') |
  Where-Object { $_ -and -not $_.StartsWith('#') } |
  ForEach-Object { $c = $_.Split('|'); [pscustomobject]@{ Nombre = $c[0]; Simb = $c[1]; Datos = $c[2]; Nota = $c[3] } }

function Leer([string] $datos, [string] $simb) {
  if ($Modo -eq 'intent') {
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($datos.Replace('<GS>', [string][char]29)))
    $extra = @('shell', 'am', 'broadcast', '-a', $accion, '-p', $paquete, '--es', 'com.sindri.pda.datos_b64', $b64)
    if ($simb) { $extra += @('--es', 'com.sindri.pda.simbologia', $simb) }
    & $adb @extra | Out-Null
  } else {
    $t = $datos
    if ($Gs -eq 'quitar') { $t = $t.Replace('<GS>', '') }
    $t = $t.Replace("'", "'\''").Replace(' ', '%s').Replace('"', '\"')
    & $adb shell "input text '$t' && input keyevent 66"
    $simb = ''
  }
  if ($LASTEXITCODE -ne 0) { throw "adb falló ($LASTEXITCODE). ¿Está el emulador arrancado? (adb devices)" }
  '→ {0,-7} {1,-4} {2}' -f $Modo, ($(if ($simb) { $simb } else { '-' })), $datos
}

if ($Lista) { $filas | ForEach-Object { '{0,-14} {1}' -f $_.Nombre, $_.Nota }; return }
if ($Todos) {
  foreach ($f in $filas) { "# $($f.Nombre): $($f.Nota)"; Leer $f.Datos $f.Simb; Start-Sleep -Milliseconds ($Pausa * 1000) }
  return
}
if (-not $Codigos) { Get-Help $PSCommandPath -Examples; return }

foreach ($c in $Codigos) {
  # Por nombre de la lista (con o sin @; en PowerShell la @ inicial hay que entrecomillarla).
  $f = $filas | Where-Object Nombre -EQ $c.TrimStart('@') | Select-Object -First 1
  if ($f) {
    Leer $f.Datos ($(if ($Simbologia) { $Simbologia } else { $f.Simb }))
  } else {
    Leer $c $Simbologia
  }
}
