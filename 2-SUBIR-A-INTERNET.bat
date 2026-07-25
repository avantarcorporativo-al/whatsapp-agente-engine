@echo off
title SUBIR A INTERNET (FIREBASE HOSTING) - WHATSAPP PAGINA UNIVERSAL CLON
color 0B
cls
echo =======================================================
echo   SUBIENDO PAGINA WHATSAPP CLON A INTERNET
echo =======================================================
echo.
echo Subiendo pagina WhatsApp CLON a Firebase Hosting...
set NODE_TLS_REJECT_UNAUTHORIZED=0
call npx firebase-tools deploy --only hosting
echo.
echo =======================================================
echo.
echo ¡Felicidades! Pagina WhatsApp CLON subida exitosamente.
echo.
echo Tu pagina WhatsApp CLON esta en linea en la direccion:
echo https://app-web-cambiar-imagenes-texto.web.app
echo.
echo =======================================================
pause
