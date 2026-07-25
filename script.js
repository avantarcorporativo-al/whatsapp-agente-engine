// =========================================================
// DATOS DE ESTADO INICIAL DEL RESTAURANTE (100% EDITABLE)
// =========================================================
const DATOS_DEFECTO = {
    general: {
        nombre: "RESTAURANTE EL SAZÓN",
        eslogan: "Sabor Gourmet & Tradición",
        telefono: "5575165733",
        telefonoWhatsapp: "5575165733",
        horario: "9:00 AM - 11:00 PM",
        direccion: "Av. Universidad #102, Pachuca, Hidalgo",
        gmapsUrl: "https://maps.app.goo.gl/eEP7NEvvrPMW916Z8",
        bannerUrl: "https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?auto=format&fit=crop&w=800&q=80",
        logoUrl: "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?auto=format&fit=crop&w=200&q=80",
        tema: "gourmet-dark",
        colorFondo: "#121212",
        colorTarjeta: "rgba(26,26,26,0.92)",
        colorTextoTarjeta: "#FFFFFF",
        colorSubtextoTarjeta: "#9CA3AF",
        colorBoton: "#D4AF37",
        colorBotonTexto: "#000000",
        geminiApiKey: "AIzaSyC6m1vQDrODxPWX_tsIpHsEBR32garG2V4",
        geminiPrompt: "Responde SIEMPRE de forma MUY CORTA, BREVE Y DIRECTA (máximo 2 a 3 renglones por respuesta). Atiende a los clientes por WhatsApp con entusiasmo, dándoles los precios exactos del menú de El Sazón."
    },
    botonesInferiores: [
        { id: "b1_inicio", texto: "Inicio", icono: "home", seccion: "sec-inicio", activo: true },
        { id: "b2_menu", texto: "Menú", icono: "restaurant_menu", seccion: "sec-menu", activo: true },
        { id: "b3_promos", texto: "Promos", icono: "local_offer", seccion: "sec-promos", activo: true },
        { id: "b4_ubicacion", texto: "Contacto", icono: "location_on", seccion: "sec-ubicacion", activo: true },
        { id: "b5_pedido", texto: "Mi Pedido", icono: "shopping_bag", seccion: "sec-pedido", activo: true }
    ],
    categorias: ["Todos", "Entradas", "Platos Fuertes", "Cortes", "Bebidas", "Postres"],
    platillos: [
        {
            id: 1,
            nombre: "Corte Rib Eye Prime 400g",
            descripcion: "Corte de res a las brasas acompañado de papas cambray y mantequilla de hierbas finas.",
            precio: 380,
            categoria: "Cortes",
            imagen: "https://images.unsplash.com/photo-1558030006-450675393462?auto=format&fit=crop&w=500&q=80",
            disponible: true
        },
        {
            id: 2,
            nombre: "Hamburguesa Gourmet Trufada",
            descripcion: "100% Sirloin, queso provolone ahumado, tocino crujiente y aderezo de trufa negra.",
            precio: 195,
            categoria: "Platos Fuertes",
            imagen: "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=500&q=80",
            disponible: true
        },
        {
            id: 3,
            nombre: "Tacos de Camarón al Pastor",
            descripcion: "3 tacos en tortilla de maíz azul, piña asada, cilantro y salsa cremosa de chipotle.",
            precio: 165,
            categoria: "Entradas",
            imagen: "https://images.unsplash.com/photo-1551504734-5ee1c4a1479b?auto=format&fit=crop&w=500&q=80",
            disponible: true
        },
        {
            id: 4,
            nombre: "Limonada de Frutos Rojos",
            descripcion: "Bebida artesanal refrescante con infusión de frutos del bosque frescos y menta.",
            precio: 65,
            categoria: "Bebidas",
            imagen: "https://images.unsplash.com/photo-1513558161293-cdaf765ed2fd?auto=format&fit=crop&w=500&q=80",
            disponible: true
        },
        {
            id: 5,
            nombre: "Cheesecake de Fruto de la Pasión",
            descripcion: "Cremoso pastel de queso al estilo New York con coulis de maracuyá casero.",
            precio: 95,
            categoria: "Postres",
            imagen: "https://images.unsplash.com/photo-1533134242443-d4fd215305ad?auto=format&fit=crop&w=500&q=80",
            disponible: true
        }
    ],
    promociones: [
        {
            id: 101,
            titulo: "Paquete Familiar 2x1",
            descuento: "2x1 ESPECIAL",
            imagen: "https://images.unsplash.com/photo-1544025162-d76694265947?auto=format&fit=crop&w=600&q=80"
        },
        {
            id: 102,
            titulo: "Combo Gourmet Nocturno",
            descuento: "20% OFF",
            imagen: "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?auto=format&fit=crop&w=600&q=80"
        }
    ]
};

const APP_VERSION = "44.0";
let appData = JSON.parse(localStorage.getItem('restaurant_data')) || JSON.parse(JSON.stringify(DATOS_DEFECTO));
let carrito = JSON.parse(localStorage.getItem('restaurant_cart')) || [];
let seccionActiva = "sec-inicio";
let categoriaActiva = "Todos";
let modoEdicionEnVivo = false;
let rolActual = null;

document.addEventListener('DOMContentLoaded', () => {
    renderizarTodo();
    iniciarConexionEventosWa();
});

function renderizarTodo() {
    renderizarGeneral();
    renderizarPlatillos();
    renderizarPromociones();
    renderizarCarrito();
}

function renderizarGeneral() {
    const elNombre = document.getElementById('header-nombre');
    if (elNombre) elNombre.textContent = appData.general.nombre;

    const elEslogan = document.getElementById('header-eslogan');
    if (elEslogan) elEslogan.textContent = appData.general.eslogan;
}

function renderizarPlatillos() {
    const container = document.getElementById('contenedor-platillos');
    if (!container) return;

    container.innerHTML = '';
    const lista = appData.platillos.filter(p => categoriaActiva === 'Todos' || p.categoria === categoriaActiva);

    lista.forEach(p => {
        const div = document.createElement('div');
        div.className = "glass-card p-3 rounded-2xl flex items-center gap-3 border border-white/10 shadow-md";
        div.innerHTML = `
            <img src="${p.imagen}" class="w-16 h-16 rounded-xl object-cover">
            <div class="flex-1">
                <h4 class="text-xs font-bold text-card-title">${p.nombre}</h4>
                <p class="text-[10px] text-card-sub line-clamp-2">${p.descripcion}</p>
                <p class="text-xs font-extrabold text-amber-400 mt-1">$${p.precio}</p>
            </div>
            <button onclick="agregarAlCarrito(${p.id})" class="btn-accent p-2 rounded-xl text-xs font-extrabold active:scale-95 transition-all">
                + Agregar
            </button>
        `;
        container.appendChild(div);
    });
}

function renderizarPromociones() {
    const container = document.getElementById('contenedor-promociones');
    if (!container) return;

    container.innerHTML = '';
    appData.promociones.forEach(pr => {
        const div = document.createElement('div');
        div.className = "glass-card p-3 rounded-2xl flex items-center justify-between border border-white/10 shadow-md";
        div.innerHTML = `
            <div>
                <h4 class="text-xs font-bold text-card-title">${pr.titulo}</h4>
                <span class="text-[10px] bg-amber-400 text-slate-950 font-black px-2 py-0.5 rounded-full">${pr.descuento}</span>
            </div>
            <img src="${pr.imagen}" class="w-14 h-14 rounded-xl object-cover">
        `;
        container.appendChild(div);
    });
}

function agregarAlCarrito(id) {
    const p = appData.platillos.find(item => item.id === id);
    if (!p) return;
    const existente = carrito.find(item => item.id === id);
    if (existente) {
        existente.cantidad++;
    } else {
        carrito.push({ ...p, cantidad: 1 });
    }
    localStorage.setItem('restaurant_cart', JSON.stringify(carrito));
    renderizarCarrito();
}

function renderizarCarrito() {
    const container = document.getElementById('contenedor-carrito');
    const totalEl = document.getElementById('cart-total');
    if (!container) return;

    container.innerHTML = '';
    let total = 0;

    carrito.forEach(item => {
        total += item.precio * item.cantidad;
        const div = document.createElement('div');
        div.className = "flex justify-between items-center text-xs text-card-title border-b border-white/10 pb-2";
        div.innerHTML = `
            <span>${item.cantidad}x ${item.nombre}</span>
            <span class="font-bold text-amber-400">$${item.precio * item.cantidad}</span>
        `;
        container.appendChild(div);
    });

    if (totalEl) totalEl.textContent = `$${total.toFixed(2)}`;
}

function vaciarCarrito() {
    carrito = [];
    localStorage.removeItem('restaurant_cart');
    renderizarCarrito();
}

function cambiarSeccionNav(seccionId) {
    document.querySelectorAll('.app-section').forEach(sec => sec.classList.add('hidden'));
    const sec = document.getElementById(seccionId);
    if (sec) sec.classList.remove('hidden');
}

function iniciarConexionEventosWa() {
    try {
        const evtSource = new EventSource('http://localhost:3001/events');
        evtSource.onmessage = function(e) {
            const data = JSON.parse(e.data);
            if (data.type === 'status') {
                const imgQr = document.getElementById('img-qr-wa-vinculacion');
                if (imgQr && data.qr) imgQr.src = data.qr;
            }
        };
    } catch(e){}
}
