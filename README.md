<p align="center">
  <img src="docs/logo.svg" alt="Cromitos Auto" width="108" height="108">
</p>

<h1 align="center">Cromitos Auto</h1>

<p align="center">
  <strong>Vende tus cromos de Steam en lote, con los precios bien puestos.</strong>
</p>

<p align="center">
  Panel de cristal en el inventario y en el mercado.<br>
  Español e inglés. Sin servidores de terceros: solo habla con Steam.
</p>

<p align="center">
  <img alt="MIT" src="https://img.shields.io/badge/licencia-MIT-7b5cff?style=flat-square">
  <img alt="ES + EN" src="https://img.shields.io/badge/idioma-ES%20+%20EN-2f7bff?style=flat-square">
  <img alt="Violentmonkey" src="https://img.shields.io/badge/instalar-Violentmonkey-e23aff?style=flat-square">
  <img alt="Poxi" src="https://img.shields.io/badge/hecho%20por-Poxi-54e6a6?style=flat-square">
</p>

<p align="center">
  <a href="#-cromitos-auto"><strong>Español</strong></a>
  ·
  <a href="#cromitos-auto--english">English</a>
</p>

---

## Instalar

1. Instala **[Violentmonkey](https://violentmonkey.github.io/)** (recomendado) o Tampermonkey.
2. **Chrome / Edge:** clic derecho en el icono → *Administrar extensión* → activa **Allow user scripts**.  
   Si te saltas esto, no aparece nada y no hay error. Firefox no lo necesita.
3. Abre [`cromitos-auto.user.js`](cromitos-auto.user.js) (o arrástralo al gestor) y confirma.

En Windows también vale **`start.bat`**: te selecciona el archivo y te recuerda los pasos.

Luego entra en [tu inventario](https://steamcommunity.com/my/inventory/) o en [el mercado](https://steamcommunity.com/market/) **con la sesión iniciada**. El panel sale abajo a la derecha.

Guía completa → [INSTALL.md](INSTALL.md)

---

## Qué hace

| En el inventario | En el mercado |
|---|---|
| **Vender todo** al céntimo por debajo del anuncio más barato | **Escanear** y colorear: verde bien, rojo caro, ámbar barato |
| **Solo duplicados** (te quedas uno de cada) | **Quitar** o **republicar** los que están mal de precio |
| Confirmación en la app de Steam, en bloque | **Mostrar todos** los anuncios, no de 10 en 10 |

El conmutador **ES / EN** está arriba a la derecha del panel y se recuerda.

> Cada anuncio nuevo hay que confirmarlo en la **app de Steam**. Es regla de Valve, no del script.

---

## Cómo decide el precio

Usa `/market/orderbook` (profundidad real en céntimos). **Primero resta tus propios anuncios** del libro: si no, el “más barato” serías tú y el panel te diría que está perfecto aunque te hayas hundido el precio.

| Color | Significado |
|---|---|
| Verde | Bien de precio (no significa “se vende ya”) |
| Rojo | Alguien está más barato — no se venderá hasta que se vayan |
| Ámbar | Eres el más barato, pero por más margen del necesario |
| Gris | No se pudo juzgar — **no se toca** |

Los grises existen para no actuar sobre un parseo mal leído. Steam a veces mete dos precios en la misma celda; si el número no cuadra con el libro, se deja en paz.

---

## Límites de Steam

Desde 2022 Steam limita el mercado por IP (~1 petición/segundo). Cromitos Auto encola todo con 1,2 s + jitter. Un inventario de 200 objetos tarda 6–8 minutos: es el límite, no un cuelgue.

---

## Privacidad

- No ve tu contraseña.
- No habla con ningún servidor que no sea `steamcommunity.com`.
- No se actualiza solo desde internet. Tú controlas el archivo.

---

## Créditos

- Lógica de mercado basada en [Steam Market Helper](https://github.com/federicogiorgi/SteamMarketHelper) de Federico Giorgi (MIT).
- Diseño, i18n y producto: **Poxi**.

MIT · Hecho con 💜 por **Poxi**

---

<a id="cromitos-auto--english"></a>

# Cromitos Auto — English

<p align="center">
  <strong>Bulk-sell your Steam cards, with listings priced properly.</strong>
</p>

<p align="center">
  A glass panel on your inventory and on the market.<br>
  Spanish and English. No third-party servers — it only talks to Steam.
</p>

<p align="center">
  <a href="#-cromitos-auto">Español</a>
  ·
  <strong>English</strong>
</p>

## Install

1. Install **[Violentmonkey](https://violentmonkey.github.io/)** (recommended) or Tampermonkey.
2. **Chrome / Edge:** right-click the icon → *Manage extension* → turn on **Allow user scripts**. Skip this and nothing appears, with no error. Firefox does not need it.
3. Open [`cromitos-auto.user.js`](cromitos-auto.user.js) (or drag it onto the manager) and confirm.

On Windows, **`start.bat`** selects the file and reminds you of the steps.

Then open [your inventory](https://steamcommunity.com/my/inventory/) or [the market](https://steamcommunity.com/market/) **while logged in**. The panel sits bottom-right.

Full guide → [INSTALL.md](INSTALL.md)

## What it does

| Inventory | Market |
|---|---|
| **Sell everything** one cent under the cheapest listing | **Scan** and colour-code: green fair, red too high, amber too low |
| **Duplicates only** (keeps one of each) | **Remove** or **relist** the mispriced ones |
| Confirm in the Steam app, in bulk | **Show all** listings instead of ten at a time |

The **ES / EN** switch is top-right on the panel and is remembered.

> Every new listing needs a confirmation in the **Steam mobile app**. That is Valve’s rule.

## How pricing works

It uses `/market/orderbook` (full depth in integer cents). **Your own listings are subtracted first.** Otherwise the cheapest price in the book is *you*, and the tool would call you perfectly placed no matter how far you had undercut yourself.

| Colour | Meaning |
|---|---|
| Green | Correctly priced (not “will sell soon”) |
| Red | Someone is cheaper — it will not sell until they leave |
| Amber | You are cheapest, but by more margin than needed |
| Grey | Could not be judged — **left alone** |

## Rate limits

Steam has had an IP-based market rate limit since 2022 (~1 request/second). Everything goes through one queue at 1.2 s + jitter. 200 items take about 6–8 minutes. That is Steam, not a hang.

## Privacy

- Never sees your password.
- Requests go only to `steamcommunity.com`.
- No remote auto-update. You control the file.

## Credits

- Market logic based on [Steam Market Helper](https://github.com/federicogiorgi/SteamMarketHelper) by Federico Giorgi (MIT).
- Design, i18n and product: **Poxi**.

MIT · Made with 💜 by **Poxi**
