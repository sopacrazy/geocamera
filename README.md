# GeoCamera

Câmera com HUD tático de geolocalização em tempo real, bússola ao vivo e galeria — 100% frontend (TypeScript + Vite), sem backend. Pronto para empacotar em APK Android via Capacitor.

## Rodar localmente

```bash
npm install
npm run dev
```

Abre em `http://localhost:3000`. Câmera, GPS e bússola exigem contexto seguro (HTTPS ou `localhost`) e, para a bússola, um dispositivo com magnetômetro (não funciona em desktop).

## Build web

```bash
npm run build      # gera dist/
npm run lint        # checagem de tipos (tsc --noEmit)
```

## Gerar o APK Android (Capacitor)

O projeto Android já está escafoldado em `android/`. Sempre que o código web mudar:

```bash
npm run cap:sync    # build + copia dist/ para android/
npm run android      # abre o projeto no Android Studio
```

No Android Studio: `Build > Build Bundle(s) / APK(s) > Build APK(s)`, ou pela linha de comando:

```bash
cd android
./gradlew assembleDebug
```

O APK debug sai em `android/app/build/outputs/apk/debug/app-debug.apk`.

### Permissões

`AndroidManifest.xml` já declara câmera e localização (fina/aproximada). O Capacitor intercepta as chamadas `getUserMedia`/`navigator.geolocation` do WebView e aciona o diálogo de permissão nativo do Android automaticamente — não é necessário nenhum plugin nativo adicional.
