# Instalar Cromitos Auto

Tres pasos. En Chrome y Edge el segundo es el que suele fallar en silencio.

---

## 1. Un gestor de userscripts

**Violentmonkey** es el recomendado: código abierto (MIT) y se mantiene.

| | Chrome | Edge | Firefox |
|---|---|---|---|
| **Violentmonkey** *(recomendado)* | [Chrome](https://chromewebstore.google.com/detail/violentmonkey/jinjaccalgkegednnccohejagnlnfdag) | [Edge](https://microsoftedge.microsoft.com/addons/detail/violentmonkey/eeagobfjdenkkddmbclomhiblgggliao) | [Firefox](https://addons.mozilla.org/firefox/addon/violentmonkey/) |
| **Tampermonkey** | [Chrome](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) | [Edge](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd) | [Firefox](https://addons.mozilla.org/firefox/addon/tampermonkey/) |

Cromitos Auto no usa APIs del gestor: se comporta igual en los dos.

---

## 2. Activa “Allow user scripts”

**En Chrome y Edge es obligatorio. Si te lo saltas, no pasa nada de nada:** ni error, ni panel.

1. Clic derecho en el icono de Violentmonkey (o Tampermonkey), arriba a la derecha.
2. **Administrar extensión**.
3. Activa **Allow user scripts**.

Chrome viejo: a veces está detrás de **Modo de desarrollador** en `chrome://extensions`.

**Firefox: sáltate este paso.** No existe y no hace falta.

---

## 3. Instala el script

- Arrastra **`cromitos-auto.user.js`** a la ventana del gestor, **o**
- Ábrelo con el gestor (doble clic suele bastar si Violentmonkey/Tampermonkey está asociado), **o**
- En el gestor: *Nuevo* → pega el contenido del archivo → guardar.

Pulsa **Instalar** / **Confirmar**.

También puedes ejecutar **`start.bat`**: te deja el archivo seleccionado en el Explorador.

---

## ¿Ha funcionado?

Entra en tu inventario de Steam o en [el mercado](https://steamcommunity.com/market/) **conectado**. Abajo a la derecha aparece el panel de cristal **Cromitos Auto**.

Arrástralo por la barra de título. El `–` lo minimiza. **ES** / **EN** cambia el idioma.

**¿No hay panel?** Por orden de probabilidad:

1. Te saltaste el paso 2 (Chrome/Edge). Casi siempre es eso.
2. No estás conectado a Steam.
3. Estás en una página que el script no cubre: inventario propio y `steamcommunity.com/market`, no fichas sueltas de un objeto.

---

## Actualizar / desinstalar

No hay actualización remota: sustituyes el archivo en el gestor (editar → pegar la versión nueva, o reinstalar).

**Desinstalar:** icono del gestor → papelera / quitar el script. En Steam no queda nada.

---

# Install Cromitos Auto *(English)*

Three steps. On Chrome and Edge, step 2 is the one that fails silently.

1. Install **Violentmonkey** (recommended) or Tampermonkey — links in the table above.
2. **Chrome / Edge only:** right-click the icon → *Manage extension* → enable **Allow user scripts**. Skip it and nothing runs, with no error. Firefox: skip this step.
3. Drag **`cromitos-auto.user.js`** onto the manager, or open it, and confirm.

Then open your Steam inventory or [the market](https://steamcommunity.com/market/) while **logged in**. A glass panel appears bottom-right.

**No panel?** You skipped step 2, you are logged out, or you are not on the inventory / market home page.

There is no remote auto-update. Replace the file in the manager when you want a new version. Uninstall via the manager’s trash icon; nothing is left on Steam.
