import { createRouter, createWebHashHistory } from "vue-router";

import Dashboard from "./views/Dashboard.vue";
import Campaigns from "./views/Campaigns.vue";
import Priorities from "./views/Priorities.vue";
import Settings from "./views/Settings.vue";

/*
 * Hash history: the daemon serves this as static files and hash routing means deep links
 * work without any server-side rewrite rules.
 */
export default createRouter({
    history: createWebHashHistory(),
    routes: [
        { path: "/", name: "dashboard", component: Dashboard },
        { path: "/campaigns", name: "campaigns", component: Campaigns },
        { path: "/campaigns/:id", name: "campaign", component: Campaigns },
        { path: "/priorities", name: "priorities", component: Priorities },
        { path: "/settings", name: "settings", component: Settings },
        { path: "/:pathMatch(.*)*", redirect: "/" },
    ],
});
