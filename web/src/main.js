import { createApp } from "vue";
import { createPinia } from "pinia";

// Only the three Element Plus pieces we actually use, with their own styles. Importing the
// full library pulled in ~1.3MB for a dashboard that needs a drawer, a switch and a toast.
import { ElDrawer, ElSwitch } from "element-plus";
import "element-plus/es/components/drawer/style/css";
import "element-plus/es/components/switch/style/css";
import "element-plus/es/components/message/style/css";

import App from "./App.vue";
import router from "./router.js";
import "./style.css";

createApp(App)
    .use(createPinia())
    .use(router)
    .component("ElDrawer", ElDrawer)
    .component("ElSwitch", ElSwitch)
    .mount("#app");
