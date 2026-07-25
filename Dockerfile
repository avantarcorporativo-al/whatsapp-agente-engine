# Imagen base ligera con Debian y Node.js 20 para soporte nativo glibc (Baileys)
FROM node:20-slim

# Instalar dependencias del sistema requeridas por Baileys y cifrado TLS
RUN apt-get update && apt-get install -y \
    ca-certificates \
    ffmpeg \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Crear directorio de trabajo
WORKDIR /usr/src/app

# Copiar manifiesto de dependencias e instalar
COPY package*.json ./
RUN npm ci --only=production

# Copiar el código del servidor y archivos del proyecto
COPY . .

# Exponer el puerto predeterminado de Cloud Run
EXPOSE 8080

# Comando de inicio del servidor
CMD ["node", "server_whatsapp.js"]
