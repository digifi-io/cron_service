'use strict';
const styles = require('../../constants/styles');

function breadCrumb(crumbs) {
  return {
    component: 'div',
    props: {
      style: {
        paddingTop: 90,
        backgroundColor:'white',
      },
    },
    children: [{
      component: 'Container',
      props: {
        style: {
          color: styles.application.blackText,
          paddingBottom: 15,
          fontSize:14,
        },
      },
      children:crumbs.map((crumb, i) => {
        return {
          component: 'span',
          children: `${crumb} ${(i<crumbs.length-1)?'›':''} `,
        };
      }),
    }]
  };
}

module.exports = {
  breadCrumb,
};