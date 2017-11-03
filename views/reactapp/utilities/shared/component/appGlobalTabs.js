'use strict';

function getTabComponent(tab, tabname, baseURL) {
  return {
    component: 'Tab',
    props: {
      isActive: (tab.location === tabname),
      style: {},
    },
    children: [{
      // component: 'ResponsiveLink',
      component: 'ResponsiveButton',
      props: {
        onClick: 'func:this.props.reduxRouter.push',
        onclickProps: `/${tab.baseURL||baseURL||'crm'}/${tab.location}`,
        // location: `/crm/${tab.location}`,
        style: {
          border: 'none',
        },
      },
      children: tab.label,
    }, ],
  };
}

function appGlobalTabs(tabs, tabname, baseURL) {
  return {
    component: 'div',
    props: {
      style: {
        backgroundColor: 'white',
        width: '100%',
        paddingTop: 70,
        borderBottom: '1px solid #d3d6db',
      },
      className: 'breadcrumb',
    },
    children: [{
      component: 'Container',
      children: [{
        component: 'Tabs',
        children: [{
          component: 'TabGroup',
          children: tabs.map(tab => getTabComponent(tab, tabname, baseURL)),
          props: {
            className: 'breadcrumb',
          },
        }, ],
      }, ]
    }, ]
  };
}

module.exports = {
  appGlobalTabs,
  getTabComponent,
};